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

  const nextState = applyBusinessModelAnswer(readState(draft.onboardingState), slug, freeText);
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

  const nextState = applyBrandPositioningAnswer(readState(draft.onboardingState), slug, freeText);
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

const HeroSelectionSchema = z.object({
  chosenIndex: z.number().int(),
  reasoning: z.string(),
});

// The "considering" beat's real work, and the reveal beat's data source —
// see GENESIS_EXPERIENCE.md's Business act mockup. Genesis picks ONE
// product from the real catalog and explains why in its own voice,
// grounded in the owner's actual words (ideaText/brandPositioningText),
// never a generic per-category template — the single most important
// moment in this act per Sean's own framing. No candidate list is
// returned to the caller; "one hero product, no catalog" is enforced
// here, not just in the UI.
export async function discoverHeroProduct(): Promise<{ state: DiscoveryState }> {
  const userId = await requireUserId();
  const draft = await getOrCreateDraft(userId);
  const state = readState(draft.onboardingState);
  if (!state.brandPositioning || !state.ideaText || !state.brandPositioningText) {
    throw new Error("Idea and brand positioning must be answered first.");
  }

  const { connector } = selectFulfillmentStrategy(state.brandPositioning, getFulfillmentConnectors());
  const candidates: FulfillmentCandidate[] = await connector.browseCandidates({
    storeId: null,
    storeDraftId: draft.id,
    brandPositioning: state.brandPositioning,
    // Real gap found via live testing: this was omitted, so the catalog
    // wasn't filtered toward the idea at all before Claude ever saw it —
    // whatever the first 8 catalog items happened to be, regardless of
    // fit. The idea text is what the owner actually said, so it's the
    // right signal to narrow the candidate list with.
    keywords: state.ideaText,
  });
  if (candidates.length === 0) {
    throw new Error("No fulfillable products were found for this catalog right now.");
  }

  const catalogSummary = candidates.map((c, i) => `${i}. ${c.name} — ${c.description.slice(0, 220)}`).join("\n");

  const outcome = await callGenesisModel(
    {
      model: "claude-opus-4-8",
      // Real bug found via live testing: 500 wasn't enough headroom for
      // adaptive thinking plus the structured JSON output at "high" effort
      // — the model spent its whole budget thinking and hit max_tokens
      // before writing any output (parsed_output came back null, silently
      // triggering the fallback path below). This is the one call in this
      // flow where the reasoning quality is the entire point, so it gets
      // real headroom rather than being trimmed to the bare minimum.
      max_tokens: 2000,
      thinking: { type: "adaptive" },
      system:
        `You are Genesis, helping someone turn a business idea into a real, sellable product.\n` +
        `They said: "${state.ideaText}"\n` +
        `The kind of brand they want: "${state.brandPositioningText}"\n\n` +
        `Choose exactly one product from the numbered catalog below that genuinely fits both what they said and the brand they described — not just a safe, generic pick. ` +
        `Then write one or two warm, specific sentences explaining why, speaking directly to the owner (e.g. "you said..."). ` +
        `Never mention a supplier, platform, or fulfillment provider by name. Never use generic marketing language like "great choice" or "perfect for your business" — be specific about what makes this one right.`,
      messages: [{ role: "user", content: catalogSummary }],
      output_config: { effort: "high", format: zodOutputFormat(HeroSelectionSchema) },
    },
    { userId }
  );

  if (!outcome.ok) {
    console.error("[discoverHeroProduct] callGenesisModel failed:", JSON.stringify(outcome));
  } else if (!outcome.message.parsed_output) {
    console.error("[discoverHeroProduct] no parsed_output, stop_reason:", outcome.message.stop_reason);
  }

  const chosenIndex = outcome.ok ? outcome.message.parsed_output?.chosenIndex : undefined;
  const candidate =
    chosenIndex !== undefined && chosenIndex >= 0 && chosenIndex < candidates.length ? candidates[chosenIndex] : candidates[0];
  const reasoning =
    (outcome.ok ? outcome.message.parsed_output?.reasoning : undefined) || "This looked like a strong fit for what you're building.";

  const nextState = applyCandidateSelected(state, candidate, reasoning);
  await persistState(draft.id, nextState);
  return { state: nextState };
}

// A read-only preview of the real cost/price/profit for the already-
// selected candidate — called when the pricing beat mounts, before the
// owner has confirmed anything. Does not persist or advance state; see
// confirmPricing below for the real, state-advancing write.
export async function getPricingPreview(): Promise<{
  costInCents: number;
  shippingInCents: number;
  recommendation: ReturnType<typeof recommendPrice>;
}> {
  const userId = await requireUserId();
  const draft = await getOrCreateDraft(userId);
  const state = readState(draft.onboardingState);
  if (!state.selectedCandidate || !state.brandPositioning) {
    throw new Error("A product must be selected before pricing it.");
  }
  const connector = getFulfillmentConnectors().find((c) => c.provider === state.selectedCandidate!.provider);
  if (!connector) throw new Error(`No connector registered for ${state.selectedCandidate.provider}.`);
  const cost = await connector.getCost({ storeId: null, storeDraftId: draft.id, candidate: state.selectedCandidate });
  const recommendation = recommendPrice(cost.costInCents, cost.shippingInCents, state.brandPositioning);
  return { costInCents: cost.costInCents, shippingInCents: cost.shippingInCents, recommendation };
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
