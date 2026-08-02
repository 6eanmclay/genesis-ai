"use server";

import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { callGenesisModel } from "@/lib/genesisModel";
import { filterKnownRevenueStreams, REVENUE_STREAM_SLUGS, BRAND_POSITIONING_SLUGS, isKnownBrandPositioning } from "@/lib/businessTaxonomy";
import { selectFulfillmentStrategy } from "@/lib/fulfillment/strategy";
import { getFulfillmentConnectors } from "@/lib/fulfillment/registry";
import { buildPrintfulAuthorizeUrl } from "@/lib/integrations/printful";
import { getBaseUrl } from "@/lib/integrations/util";
import { recommendPrice, applyOwnerPrice } from "@/lib/onboarding/pricing";
import {
  initialDiscoveryState,
  applyBusinessModelAnswer,
  applyBrandPositioningAnswer,
  applyProductSourceAnswer,
  applyCandidateSelected,
  applyPricingConfirmed,
} from "@/lib/onboarding/discoveryFlow";
import type { DiscoveryState, OnboardingState } from "@/lib/onboarding/types";
import type { FulfillmentCandidate } from "@/lib/fulfillment/types";

// Onboarding v2 — the server actions driving the guided discovery flow
// (lib/onboarding/discoveryFlow.ts's pure state machine, called here with
// the results of real I/O: an AI classification call, a real fulfillment
// API call). Feature-gated by ONBOARDING_V2_ENABLED (see
// ONBOARDING_V2_IMPLEMENTATION.md section 8) — every export here assumes
// the caller has already checked the flag; this file doesn't check it
// itself, matching how other feature-specific action files in this
// codebase don't duplicate a gate their caller already enforces.

async function requireUserId(): Promise<string> {
  const session = await auth();
  if (!session?.user) throw new Error("Not signed in");
  return session.user.id;
}

async function getOrCreateDraft(userId: string) {
  const existing = await prisma.storeDraft.findUnique({ where: { userId } });
  if (existing) return existing;
  return prisma.storeDraft.create({
    data: { userId, name: "New store", status: "onboarding_discovery" },
  });
}

function readState(onboardingState: unknown): DiscoveryState {
  return (onboardingState as OnboardingState | null) ?? initialDiscoveryState();
}

async function persistState(storeDraftId: string, state: DiscoveryState, extra?: { brandPositioning?: string }) {
  const draft = await prisma.storeDraft.findUnique({ where: { id: storeDraftId } });
  const existing = (draft?.onboardingState as OnboardingState | null) ?? null;
  const next: OnboardingState = { ...state, fulfillmentCredentials: existing?.fulfillmentCredentials };
  await prisma.storeDraft.update({
    where: { id: storeDraftId },
    data: {
      onboardingState: next as unknown as object,
      ...(extra?.brandPositioning ? { brandPositioning: extra.brandPositioning } : {}),
    },
  });
  return next;
}

export async function getOnboardingState(): Promise<{ storeDraftId: string; state: DiscoveryState }> {
  const userId = await requireUserId();
  const draft = await getOrCreateDraft(userId);
  return { storeDraftId: draft.id, state: readState(draft.onboardingState) };
}

const BusinessModelClassificationSchema = z.object({ slug: z.enum(REVENUE_STREAM_SLUGS as [string, ...string[]]) });

// A small, standalone classification call — deliberately not reusing
// ai-actions.ts's concurrent-with-generation classifier (see
// ONBOARDING_V2_DESIGN.md section 3(d)'s finding): that one runs alongside
// the full store-generation call and is used as a label; this one has to
// resolve on its own, before Genesis decides whether to enter the
// ecommerce guided flow at all.
export async function submitBusinessModelAnswer(freeText: string): Promise<{ state: DiscoveryState }> {
  const userId = await requireUserId();
  const draft = await getOrCreateDraft(userId);

  const outcome = await callGenesisModel(
    {
      model: "claude-opus-4-8",
      max_tokens: 200,
      thinking: { type: "adaptive" },
      system: `Classify what kind of business this is, choosing exactly one slug from this list: ${REVENUE_STREAM_SLUGS.join(", ")}. Pick "other" only if nothing else genuinely fits.`,
      messages: [{ role: "user", content: freeText }],
      output_config: { effort: "low", format: zodOutputFormat(BusinessModelClassificationSchema) },
    },
    { userId }
  );
  const slug = outcome.ok ? (filterKnownRevenueStreams([outcome.message.parsed_output?.slug ?? "other"])[0] ?? "other") : "other";

  const nextState = applyBusinessModelAnswer(readState(draft.onboardingState), slug);
  await persistState(draft.id, nextState);
  return { state: nextState };
}

const BrandPositioningClassificationSchema = z.object({ slug: z.enum(BRAND_POSITIONING_SLUGS as [string, ...string[]]) });

export async function submitBrandPositioningAnswer(freeText: string): Promise<{ state: DiscoveryState }> {
  const userId = await requireUserId();
  const draft = await getOrCreateDraft(userId);

  const outcome = await callGenesisModel(
    {
      model: "claude-opus-4-8",
      max_tokens: 200,
      thinking: { type: "adaptive" },
      system: `Classify what kind of brand this owner wants to build, choosing exactly one slug from this list: ${BRAND_POSITIONING_SLUGS.join(", ")}. Pick "other" only if nothing else genuinely fits.`,
      messages: [{ role: "user", content: freeText }],
      output_config: { effort: "low", format: zodOutputFormat(BrandPositioningClassificationSchema) },
    },
    { userId }
  );
  const rawSlug = outcome.ok ? outcome.message.parsed_output?.slug : undefined;
  const slug = rawSlug && isKnownBrandPositioning(rawSlug) ? rawSlug : "other";

  const nextState = applyBrandPositioningAnswer(readState(draft.onboardingState), slug);
  await persistState(draft.id, nextState, { brandPositioning: slug });
  return { state: nextState };
}

export async function submitProductSourceAnswer(source: "existing" | "discover"): Promise<{ state: DiscoveryState }> {
  const userId = await requireUserId();
  const draft = await getOrCreateDraft(userId);
  const nextState = applyProductSourceAnswer(readState(draft.onboardingState), source);
  await persistState(draft.id, nextState);
  return { state: nextState };
}

// Returns the URL the client should navigate to — the strategy evaluation
// (lib/fulfillment/strategy.ts) picks the connector internally; the owner
// never sees which one.
export async function startFulfillmentConnect(): Promise<{ authorizeUrl: string; rationale: string }> {
  const userId = await requireUserId();
  const draft = await getOrCreateDraft(userId);
  const state = readState(draft.onboardingState);
  if (!state.brandPositioning) throw new Error("Brand positioning must be answered first.");

  const { connector, rationale } = selectFulfillmentStrategy(state.brandPositioning);
  if (connector.provider !== "PRINTFUL") {
    throw new Error(`No draft-phase connect flow implemented yet for ${connector.provider}.`);
  }
  const baseUrl = await getBaseUrl();
  const redirectUrl = `${baseUrl}/api/onboarding/fulfillment/callback`;
  const authorizeUrl = buildPrintfulAuthorizeUrl(redirectUrl, `${draft.id}:PRINTFUL`);
  return { authorizeUrl, rationale };
}

export async function browseFulfillmentCandidates(keywords?: string): Promise<{ candidates: FulfillmentCandidate[]; rationale: string }> {
  const userId = await requireUserId();
  const draft = await getOrCreateDraft(userId);
  const state = readState(draft.onboardingState);
  if (!state.brandPositioning) throw new Error("Brand positioning must be answered first.");

  const { connector, rationale } = selectFulfillmentStrategy(state.brandPositioning, getFulfillmentConnectors());
  const candidates = await connector.browseCandidates({
    storeId: null,
    storeDraftId: draft.id,
    brandPositioning: state.brandPositioning,
    keywords,
  });
  return { candidates, rationale };
}

export async function selectFulfillmentCandidate(
  candidate: FulfillmentCandidate
): Promise<{ state: DiscoveryState; recommendation: ReturnType<typeof recommendPrice> }> {
  const userId = await requireUserId();
  const draft = await getOrCreateDraft(userId);
  const state = readState(draft.onboardingState);
  if (!state.brandPositioning) throw new Error("Brand positioning must be answered first.");

  const connector = getFulfillmentConnectors().find((c) => c.provider === candidate.provider);
  if (!connector) throw new Error(`No connector registered for ${candidate.provider}.`);
  const cost = await connector.getCost({ storeId: null, storeDraftId: draft.id, candidate });
  const recommendation = recommendPrice(cost.costInCents, cost.shippingInCents, state.brandPositioning);

  const nextState = applyCandidateSelected(state, candidate);
  await persistState(draft.id, nextState);
  return { state: nextState, recommendation };
}

// `retailPriceInCents` present => the owner's own explicit override (fixed
// amount, percentage, or fully custom all reduce to this by the time the
// UI calls here); absent => accept Genesis's recommendation as-is.
export async function confirmPricing(retailPriceInCents?: number): Promise<{ state: DiscoveryState }> {
  const userId = await requireUserId();
  const draft = await getOrCreateDraft(userId);
  const state = readState(draft.onboardingState);
  if (!state.selectedCandidate || !state.brandPositioning) {
    throw new Error("A product must be selected before confirming pricing.");
  }

  const connector = getFulfillmentConnectors().find((c) => c.provider === state.selectedCandidate!.provider);
  if (!connector) throw new Error(`No connector registered for ${state.selectedCandidate.provider}.`);
  const cost = await connector.getCost({ storeId: null, storeDraftId: draft.id, candidate: state.selectedCandidate });
  const pricing =
    retailPriceInCents !== undefined
      ? applyOwnerPrice(cost.costInCents, cost.shippingInCents, retailPriceInCents)
      : recommendPrice(cost.costInCents, cost.shippingInCents, state.brandPositioning);

  // No draft-order preview here — createDraftOrder needs a real print-file
  // image (confirmed live: a catalog candidate's own mockup imageUrl is
  // NOT a valid one, see lib/fulfillment/types.ts), and no real artwork
  // exists yet at this point in discovery. The pricing math above is
  // already real (getCost's live cost/shipping figures), so this doesn't
  // need a redundant preview order to be trustworthy. The real, validated
  // safe-draft-order capability is used for real once real artwork exists
  // — at actual product creation in confirmStoreDraftCore.
  const nextState = applyPricingConfirmed(state, pricing);
  await persistState(draft.id, nextState);
  return { state: nextState };
}
