"use server";

import { z } from "zod";
import { Prisma } from "@prisma/client";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { callGenesisModel, genesisModelFailureMessage } from "@/lib/genesisModel";
import type { GenesisModelScope } from "@/lib/genesisModel";
import { ANONYMOUS_USAGE_CEILING_MESSAGE } from "@/lib/dashboard/genesisModelMessages";
import { filterKnownRevenueStreams, REVENUE_STREAM_SLUGS, BRAND_POSITIONING_SLUGS, isKnownBrandPositioning } from "@/lib/businessTaxonomy";
import { selectFulfillmentStrategy } from "@/lib/fulfillment/strategy";
import { getFulfillmentConnectors } from "@/lib/fulfillment/registry";
import { buildPrintfulAuthorizeUrl } from "@/lib/integrations/printful";
import { getBaseUrl } from "@/lib/integrations/util";
import { recommendPrice, applyOwnerPrice } from "@/lib/onboarding/pricing";
import { GeneratedImageProvider } from "@/lib/imageProviders/generatedImageProvider";
import { uploadProductImageFile } from "@/lib/imageProviders/uploadProvider";
import { confirmStoreDraftCore } from "@/app/dashboard/ai-actions";
import { getOrCreateAnonymousSessionId, peekAnonymousSessionId, clearAnonymousSessionCookie } from "@/lib/onboarding/anonymousSession";
import {
  initialDiscoveryState,
  applyBusinessModelAnswer,
  applyBrandPositioningAnswer,
  applyCreativeApproachAnswer,
  applyCreativeDirectionsGenerated,
  applyCreativeDirectionSelected,
  applyArtworkUploaded,
  applyProductSourceAnswer,
  applyCandidateSelected,
  applyPricingConfirmed,
  applyFulfillmentStrategyChosen,
  applySelfFulfillmentPriced,
} from "@/lib/onboarding/discoveryFlow";
import type {
  CreativeDirectionOption,
  DiscoveryState,
  OnboardingState,
  ExperienceConcept,
  ExperienceDecision,
  ExperienceState,
  ExperienceTranscriptEntry,
} from "@/lib/onboarding/types";
import { initialExperienceState, MAX_VISITOR_TURNS_BEFORE_FORCED_GENERATION } from "@/lib/onboarding/experienceFlow";
import type { FulfillmentCandidate } from "@/lib/fulfillment/types";
import { DEFAULT_THEME } from "@/lib/theme";
import type { Theme, ThemeColors } from "@/lib/theme";

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
  try {
    return await prisma.storeDraft.create({
      data: { userId, name: "New store", status: "onboarding_discovery" },
    });
  } catch (error) {
    // Beta readiness — a real race caught live during a first-time-user
    // walkthrough, not a hypothetical: two near-simultaneous requests for
    // a brand-new user (a double-click on "Get Started," or a browser
    // prefetch racing the real navigation) can both pass the findUnique
    // check above before either write lands. The loser hit this exact
    // unique constraint and crashed straight to the root error boundary —
    // right after signup, the very first real screen. Re-fetch instead of
    // failing; the winner's row is exactly what this call wanted anyway.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const draft = await prisma.storeDraft.findUnique({ where: { userId } });
      if (draft) return draft;
    }
    throw error;
  }
}

// Experience-First Onboarding — the anonymous-visitor counterpart to
// getOrCreateDraft above. Same shape, keyed by the signed session identity
// from lib/onboarding/anonymousSession.ts instead of a real userId. No User
// row involved at any point — see EXPERIENCE_FIRST_ONBOARDING.md's
// confirmed "no shadow users" decision.
async function getOrCreateAnonymousDraft() {
  const anonymousSessionToken = await getOrCreateAnonymousSessionId();
  const existing = await prisma.storeDraft.findUnique({ where: { anonymousSessionToken } });
  if (existing) return existing;
  try {
    return await prisma.storeDraft.create({
      data: { anonymousSessionToken, name: "New store", status: "onboarding_discovery" },
    });
  } catch (error) {
    // Same real race as getOrCreateDraft above, same fix.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const draft = await prisma.storeDraft.findUnique({ where: { anonymousSessionToken } });
      if (draft) return draft;
    }
    throw error;
  }
}

function readState(onboardingState: unknown): DiscoveryState {
  return (onboardingState as OnboardingState | null) ?? initialDiscoveryState();
}

async function persistState(
  storeDraftId: string,
  state: DiscoveryState,
  extra?: { brandPositioning?: string; creativeDirection?: CreativeDirectionOption }
) {
  const draft = await prisma.storeDraft.findUnique({ where: { id: storeDraftId } });
  const existing = (draft?.onboardingState as OnboardingState | null) ?? null;
  const next: OnboardingState = { ...state, fulfillmentCredentials: existing?.fulfillmentCredentials };
  await prisma.storeDraft.update({
    where: { id: storeDraftId },
    data: {
      onboardingState: next as unknown as object,
      ...(extra?.brandPositioning ? { brandPositioning: extra.brandPositioning } : {}),
      ...(extra?.creativeDirection ? { creativeDirection: extra.creativeDirection as unknown as object } : {}),
    },
  });
  return next;
}

export async function getOnboardingState(): Promise<{ storeDraftId: string; state: DiscoveryState }> {
  const userId = await requireUserId();
  const draft = await getOrCreateDraft(userId);
  return { storeDraftId: draft.id, state: readState(draft.onboardingState) };
}

function readExperienceState(experienceState: unknown): ExperienceState {
  return (experienceState as ExperienceState | null) ?? initialExperienceState();
}

// Experience-First Onboarding — the anonymous entry point's first read, called
// from app/page.tsx's Server Component render. Deliberately read-only (see
// peekAnonymousSessionId's own comment): a brand-new visitor with no cookie
// yet gets the honest empty state, no draft row and no cookie minted just
// from loading the page. A returning-mid-conversation visitor (real cookie
// already set by a prior submitExperienceMessage call) resumes exactly
// where they left off.
export async function getExperienceState(): Promise<ExperienceState> {
  const anonymousSessionToken = await peekAnonymousSessionId();
  if (!anonymousSessionToken) return initialExperienceState();
  const draft = await prisma.storeDraft.findUnique({ where: { anonymousSessionToken } });
  return readExperienceState(draft?.experienceState);
}

const ExperienceDecisionSchema = z.object({
  confident: z.boolean(),
  clarifyingQuestion: z.string().nullable(),
  concept: z
    .object({
      businessModelSlug: z.enum(REVENUE_STREAM_SLUGS as [string, ...string[]]),
      brandPositioning: z.enum(BRAND_POSITIONING_SLUGS as [string, ...string[]]),
      name: z.string(),
      description: z.string(),
      brandVoice: z.string(),
      photographyStyle: z.string(),
      colors: z.object({
        primary: z.string(),
        secondary: z.string(),
        accent: z.string(),
        background: z.string(),
        surface: z.string(),
        text: z.string(),
        textSecondary: z.string(),
      }),
      typography: z.object({ headingFont: z.string(), bodyFont: z.string() }),
      logoImagePrompt: z.string(),
      productImagePrompt: z.string(),
      productName: z.string(),
      productDescription: z.string(),
      estimatedCostInCents: z.number(),
      estimatedShippingInCents: z.number(),
    })
    .nullable(),
});

// The reasoning boundary described on ExperienceDecision in lib/onboarding/
// types.ts — everything a future J4 reasoning engine would need to replace
// is contained in this one function. Today: one structured-output call,
// given the full transcript so far, that both decides whether to ask or
// generate AND produces the generation content in the same pass (no second
// round trip once confident). Text-only, same split generateCreativeDirections
// already uses below — image generation happens in the caller.
async function decideExperienceNextStep(
  transcript: ExperienceTranscriptEntry[],
  scope: GenesisModelScope
): Promise<ExperienceDecision> {
  const visitorTurns = transcript.filter((entry) => entry.role === "visitor").length;
  const mustDecideNow = visitorTurns >= MAX_VISITOR_TURNS_BEFORE_FORCED_GENERATION;
  const transcriptText = transcript.map((entry) => `${entry.role === "visitor" ? "Visitor" : "Genesis"}: ${entry.text}`).join("\n");

  const outcome = await callGenesisModel(
    {
      model: "claude-opus-4-8",
      max_tokens: 3000,
      thinking: { type: "adaptive" },
      system:
        `You are Genesis, meeting a brand-new visitor for the first time. They're describing a business idea, one ` +
        `message at a time. Decide: do you already understand enough to create something real and exciting, or do ` +
        `you genuinely need one more concrete detail first?\n\n` +
        `Bias strongly toward creating immediately — the goal is momentum, not information. Only set confident=false ` +
        `if the idea is so open-ended you'd otherwise have to invent something they might not want (no hint of ` +
        `audience, style, or product), or if what they've described isn't a sellable product business yet (only ` +
        `"product_sales" and "digital_products" have a guided path today) — in that second case, your one question ` +
        `should warmly redirect them toward a product idea, never reject them outright.\n\n` +
        (mustDecideNow
          ? `This is the last turn before you must commit — set confident=true no matter what, and make your best ` +
            `creative judgment on anything still unclear.`
          : `If you ask, ask exactly ONE concise, specific question — never generic, never an interview. It should ` +
            `feel like you're refining a vision you're already excited about, not making them fill out a form.`) +
        `\n\nWhen confident: invent a complete creative concept — a business name, description, brand voice, ` +
        `photography style, a full color palette and typography pairing, one specific first product to sell, and ` +
        `real image-generation prompts for a logo (a clean, simple mark, not a full scene) and a product photo. ` +
        `Also give an honest, typical print-on-demand cost estimate in cents for producing and shipping that one ` +
        `product — a real range for its category, not padded or invented to hit a target price.`,
      messages: [{ role: "user", content: transcriptText }],
      output_config: { effort: "medium", format: zodOutputFormat(ExperienceDecisionSchema) },
    },
    { ...scope, feature: "onboarding_experience_decision" }
  );

  // A real provider-level failure (usage ceiling, billing, rate limit,
  // network) gets its own honest message — never masked as a generic
  // clarifying question, which would tell an anonymous visitor who just
  // hit today's limit that Genesis simply needs more information. Every
  // other failure kind reuses the app's one shared error vocabulary
  // (genesisModelFailureMessage) rather than inventing new copy here.
  if (!outcome.ok) {
    const message = outcome.kind === "usage_ceiling" ? ANONYMOUS_USAGE_CEILING_MESSAGE : genesisModelFailureMessage(outcome.kind);
    throw new Error(message);
  }

  const parsed = outcome.message.parsed_output;
  const malformed = !parsed || (!parsed.confident && !parsed.clarifyingQuestion) || (parsed.confident && !parsed.concept);
  if (malformed) {
    // Degrades to one honest follow-up rather than a crashed turn or an
    // invented concept — there's no safe default business identity here.
    return { action: "ask", question: "Tell me a bit more about what you're picturing — I want to get this right." };
  }
  if (!parsed.confident) {
    return { action: "ask", question: parsed.clarifyingQuestion! };
  }
  const concept = parsed.concept!;
  return {
    action: "generate",
    concept: { ...concept, colors: concept.colors as ThemeColors },
  };
}

// Experience-First Onboarding — the real entry point every message from the
// new landing experience calls. No auth — rate-limited by
// ANONYMOUS_DAILY_TOKEN_CEILING (lib/genesisModel.ts, Milestone 5), a
// deliberately tighter ceiling than the real per-account budget, through
// the same callGenesisModel governance path every other AI call uses.
export async function submitExperienceMessage(
  text: string
): Promise<{ status: "collecting"; question: string } | { status: "generated"; concept: ExperienceConcept }> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Tell Genesis a little about the business first.");

  const draft = await getOrCreateAnonymousDraft();
  const anonymousSessionToken = draft.anonymousSessionToken;
  if (!anonymousSessionToken) throw new Error("Anonymous session is missing — try reloading the page.");
  const scope: GenesisModelScope = { anonymousSessionToken };

  const state = readExperienceState(draft.experienceState);
  const transcript: ExperienceTranscriptEntry[] = [...state.transcript, { role: "visitor", text: trimmed }];

  const decision = await decideExperienceNextStep(transcript, scope);

  if (decision.action === "ask") {
    const nextTranscript: ExperienceTranscriptEntry[] = [...transcript, { role: "genesis", text: decision.question }];
    const nextState: ExperienceState = { transcript: nextTranscript, status: "collecting", concept: null };
    await prisma.storeDraft.update({ where: { id: draft.id }, data: { experienceState: nextState as unknown as object } });
    return { status: "collecting", question: decision.question };
  }

  const raw = decision.concept;
  const [productImage, logoImage] = await Promise.all([
    GeneratedImageProvider.source({
      prompt: raw.productImagePrompt,
      name: raw.productName,
      description: raw.description,
      excludeUrls: [],
      scope,
      feature: "product_image_generation",
    }),
    GeneratedImageProvider.source({
      prompt: raw.logoImagePrompt,
      name: `${raw.name} logo`,
      description: raw.description,
      excludeUrls: [],
      scope,
      feature: "onboarding_creative_direction_generation",
    }),
  ]);
  if (!productImage || !logoImage) {
    throw new Error("Genesis couldn't finish generating artwork just now — try again in a moment.");
  }

  const pricing = recommendPrice(raw.estimatedCostInCents, raw.estimatedShippingInCents, raw.brandPositioning);
  const concept: ExperienceConcept = {
    businessModelSlug: raw.businessModelSlug,
    brandPositioning: raw.brandPositioning,
    creativeDirection: {
      name: raw.name,
      description: raw.description,
      brandVoice: raw.brandVoice,
      photographyStyle: raw.photographyStyle,
      colors: raw.colors,
      typography: raw.typography,
      logoUrl: logoImage.url,
      productImageUrl: productImage.url,
    },
    productName: raw.productName,
    productDescription: raw.productDescription,
    pricing,
  };

  const nextState: ExperienceState = { transcript, status: "generated", concept };
  await prisma.storeDraft.update({ where: { id: draft.id }, data: { experienceState: nextState as unknown as object } });
  return { status: "generated", concept };
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
    { userId, feature: "onboarding_business_model_classification" }
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
    { userId, feature: "onboarding_brand_positioning_classification" }
  );
  const rawSlug = outcome.ok ? outcome.message.parsed_output?.slug : undefined;
  const slug = rawSlug && isKnownBrandPositioning(rawSlug) ? rawSlug : "other";

  const nextState = applyBrandPositioningAnswer(readState(draft.onboardingState), slug, freeText);
  await persistState(draft.id, nextState, { brandPositioning: slug });
  return { state: nextState };
}

// Custom-design vs. reselling/curating a blank as-is — a lightweight,
// no-AI-call binary choice, same shape as submitProductSourceAnswer below.
export async function submitCreativeApproachAnswer(
  approach: "custom" | "upload" | "resell"
): Promise<{ state: DiscoveryState }> {
  const userId = await requireUserId();
  const draft = await getOrCreateDraft(userId);
  const nextState = applyCreativeApproachAnswer(readState(draft.onboardingState), approach);
  await persistState(draft.id, nextState);
  return { state: nextState };
}

const CreativeDirectionTextSchema = z.object({
  name: z.string(),
  description: z.string(),
  brandVoice: z.string(),
  photographyStyle: z.string(),
  colors: z.object({
    primary: z.string(),
    secondary: z.string(),
    accent: z.string(),
    background: z.string(),
    surface: z.string(),
    text: z.string(),
    textSecondary: z.string(),
  }),
  typography: z.object({ headingFont: z.string(), bodyFont: z.string() }),
  productImagePrompt: z.string(),
  logoImagePrompt: z.string(),
});

// Three fixed creative-angle anchors, not left to chance — three identical-
// context calls to the same model with no differentiating signal could
// plausibly converge on similar answers. Anchored on Sean's own
// illustration (clean/minimal, bold/energetic, premium/elevated), phrased
// generally enough to apply across business types — the real idea/brand-
// positioning text still grounds each direction, the anchor only nudges
// the angle, never overrides what the owner actually said.
const CREATIVE_LENSES = [
  {
    id: "minimal",
    instruction: "Lean clean, modern, and minimal — restrained palette, quiet confidence, more whitespace than color.",
  },
  {
    id: "bold",
    instruction: "Lean bold and energetic — strong contrast, a statement color, unafraid to be loud where it fits the brand.",
  },
  {
    id: "premium",
    instruction: "Lean premium and elevated — a luxury-lifestyle feel, refined materials and language, nothing discount-feeling.",
  },
] as const;

async function generateOneCreativeDirection(
  lens: (typeof CREATIVE_LENSES)[number],
  ideaText: string,
  brandPositioningText: string,
  userId: string
): Promise<z.infer<typeof CreativeDirectionTextSchema> | null> {
  const outcome = await callGenesisModel(
    {
      model: "claude-opus-4-8",
      max_tokens: 2500,
      thinking: { type: "adaptive" },
      system:
        `You are Genesis, generating ONE of three genuinely different creative directions for a new business's ` +
        `product design, logo, color palette, typography, brand voice, and photography style. ${lens.instruction}\n` +
        `Write productImagePrompt and logoImagePrompt as real, specific image-generation prompts (not descriptions ` +
        `of a prompt) — they'll be sent directly to an image model. logoImagePrompt should describe a clean, simple ` +
        `mark or icon suitable as a small logo, not a full scene. brandVoice and photographyStyle are short guidance ` +
        `text for Genesis's own future use, not customer-facing copy.`,
      messages: [
        { role: "user", content: `They said: "${ideaText}"\nThe brand they want: "${brandPositioningText}"` },
      ],
      output_config: { effort: "medium", format: zodOutputFormat(CreativeDirectionTextSchema) },
    },
    { userId, feature: "onboarding_creative_direction_generation" }
  );
  return outcome.ok ? (outcome.message.parsed_output ?? null) : null;
}

// The Business act's creative climax, custom-design path — three parallel,
// genuinely different directions, not one generic pick with variations.
// Deliberately three separate calls, not one array call: app/dashboard/
// ai-actions.ts already hit a real "compiled grammar is too large" ceiling
// once (why theme.composition is generated as its own call there) — this
// stays well clear of that risk, and gives free per-direction failure
// isolation, which the required behavior needs anyway (a direction that
// fails to generate is simply unavailable, never patched with a fallback).
export async function generateCreativeDirections(): Promise<{ state: DiscoveryState }> {
  const userId = await requireUserId();
  const draft = await getOrCreateDraft(userId);
  const state = readState(draft.onboardingState);
  if (!state.ideaText || !state.brandPositioningText) {
    throw new Error("Idea and brand positioning must be answered first.");
  }
  const ideaText = state.ideaText;
  const brandPositioningText = state.brandPositioningText;

  const textResults = await Promise.all(
    CREATIVE_LENSES.map((lens) => generateOneCreativeDirection(lens, ideaText, brandPositioningText, userId))
  );

  // Image generation direct via GeneratedImageProvider — deliberately NOT
  // resolveProductImage(), whose stock-photo fallback would defeat the
  // entire point (a random stock photo is not "your custom design"). A
  // direction missing either image is unavailable, not stock-patched.
  const withImages = await Promise.all(
    textResults.map(async (direction) => {
      if (!direction) return null;
      const [productImage, logoImage] = await Promise.all([
        GeneratedImageProvider.source({
          prompt: direction.productImagePrompt,
          name: direction.name,
          description: direction.description,
          excludeUrls: [],
          scope: { userId },
          feature: "product_image_generation",
        }),
        GeneratedImageProvider.source({
          prompt: direction.logoImagePrompt,
          name: `${direction.name} logo`,
          description: direction.description,
          excludeUrls: [],
          scope: { userId },
          feature: "onboarding_creative_direction_generation",
        }),
      ]);
      if (!productImage || !logoImage) return null;
      const option: CreativeDirectionOption = {
        name: direction.name,
        description: direction.description,
        brandVoice: direction.brandVoice,
        photographyStyle: direction.photographyStyle,
        colors: direction.colors as ThemeColors,
        typography: direction.typography,
        logoUrl: logoImage.url,
        productImageUrl: productImage.url,
      };
      return option;
    })
  );

  const directions = withImages.filter((d): d is CreativeDirectionOption => d !== null);
  if (directions.length === 0) {
    throw new Error("Genesis couldn't put together any creative directions right now — try again in a moment.");
  }

  const nextState = applyCreativeDirectionsGenerated(readState(draft.onboardingState), directions);
  await persistState(draft.id, nextState);
  return { state: nextState };
}

export async function selectCreativeDirection(index: number): Promise<{ state: DiscoveryState }> {
  const userId = await requireUserId();
  const draft = await getOrCreateDraft(userId);
  const state = readState(draft.onboardingState);
  const chosen = state.creativeDirectionOptions?.[index];
  if (!chosen) throw new Error("That direction isn't available anymore — try generating again.");

  const nextState = applyCreativeDirectionSelected(state, chosen);
  await persistState(draft.id, nextState, { creativeDirection: chosen });
  return { state: nextState };
}

// The "I already have artwork" path — deliberately a smaller schema than
// CreativeDirectionTextSchema, which carries productImagePrompt/
// logoImagePrompt fields this path never needs (the owner supplies the
// artwork directly, nothing to generate an image from). No lens either —
// there's only ever one real direction here, not three to diverge across.
const UploadedArtworkIdentitySchema = z.object({
  name: z.string(),
  description: z.string(),
  brandVoice: z.string(),
  photographyStyle: z.string(),
  colors: z.object({
    primary: z.string(),
    secondary: z.string(),
    accent: z.string(),
    background: z.string(),
    surface: z.string(),
    text: z.string(),
    textSecondary: z.string(),
  }),
  typography: z.object({ headingFont: z.string(), bodyFont: z.string() }),
});

export async function submitUploadedArtwork(formData: FormData): Promise<{ state: DiscoveryState }> {
  const userId = await requireUserId();
  const draft = await getOrCreateDraft(userId);
  const state = readState(draft.onboardingState);
  if (!state.ideaText || !state.brandPositioningText) {
    throw new Error("Idea and brand positioning must be answered first.");
  }

  const file = formData.get("artwork");
  if (!(file instanceof File) || file.size === 0) {
    throw new Error("Please choose an image to upload.");
  }
  // Real, already-proven upload path — same validation (PNG/JPEG/WebP,
  // 8MB max) and same Vercel Blob upload app/dashboard/actions.ts's
  // uploadProductImage already uses for a live store's own product photos.
  const sourced = await uploadProductImageFile(file);

  const outcome = await callGenesisModel(
    {
      model: "claude-opus-4-8",
      max_tokens: 1500,
      thinking: { type: "adaptive" },
      system:
        `You are Genesis, naming and describing a business whose owner already has their own product artwork — ` +
        `you are not designing anything visual, just the identity: a name, a short description, a color palette ` +
        `and typography pairing, and brand voice/photography style guidance for Genesis's own future use. ` +
        `Ground this in what they actually said, not a generic template.`,
      messages: [
        {
          role: "user",
          content: `They said: "${state.ideaText}"\nThe brand they want: "${state.brandPositioningText}"`,
        },
      ],
      output_config: { effort: "medium", format: zodOutputFormat(UploadedArtworkIdentitySchema) },
    },
    { userId, feature: "onboarding_uploaded_artwork_identity" }
  );
  if (!outcome.ok || !outcome.message.parsed_output) {
    throw new Error("Genesis couldn't put this together right now — try again in a moment.");
  }
  const identity = outcome.message.parsed_output;

  // Same uploaded image for both — a deliberate v1 simplification (one
  // upload, not two) rather than asking for a separate logo file.
  const direction: CreativeDirectionOption = {
    name: identity.name,
    description: identity.description,
    brandVoice: identity.brandVoice,
    photographyStyle: identity.photographyStyle,
    colors: identity.colors as ThemeColors,
    typography: identity.typography,
    logoUrl: sourced.url,
    productImageUrl: sourced.url,
  };

  const nextState = applyArtworkUploaded(state, direction);
  await persistState(draft.id, nextState, { creativeDirection: direction });
  return { state: nextState };
}

export async function submitProductSourceAnswer(source: "existing" | "discover"): Promise<{ state: DiscoveryState }> {
  const userId = await requireUserId();
  const draft = await getOrCreateDraft(userId);
  const nextState = applyProductSourceAnswer(readState(draft.onboardingState), source);
  await persistState(draft.id, nextState);
  return { state: nextState };
}

// Beta feedback (2026-08-06) — fulfillment is a real choice, never a
// required step. Pure state transition (applyFulfillmentStrategyChosen)
// decides where this goes; this action is just the same thin persist
// wrapper every other submitXAnswer action already is.
export async function submitFulfillmentStrategy(
  strategy: "printful" | "self" | "other" | "later"
): Promise<{ state: DiscoveryState }> {
  const userId = await requireUserId();
  const draft = await getOrCreateDraft(userId);
  const nextState = applyFulfillmentStrategyChosen(readState(draft.onboardingState), strategy);
  await persistState(draft.id, nextState);
  return { state: nextState };
}

// The self-fulfillment counterpart to confirmPricing below — no connector,
// no getCost() call, just the owner's own real all-in number fed through
// the identical recommendPrice() every Printful-backed product already
// prices with. Only ever reached from custom/upload (see
// applyFulfillmentStrategyChosen), which always has a real creativeDirection
// and brandPositioning by this point.
export async function confirmSelfFulfillmentPricing(
  costInCents: number
): Promise<{ state: DiscoveryState; storeUrl?: string; storeName?: string }> {
  const userId = await requireUserId();
  const draft = await getOrCreateDraft(userId);
  const state = readState(draft.onboardingState);
  if (!state.brandPositioning || !state.creativeDirection) {
    throw new Error("A creative direction must be chosen before pricing.");
  }

  const recommendation = recommendPrice(costInCents, 0, state.brandPositioning);
  const nextState = applySelfFulfillmentPriced(state, costInCents, recommendation);
  await persistState(draft.id, nextState);

  // Mirrors confirmPricing's own early-materialization call exactly — see
  // that function's own comment for why this must run right after
  // persistState, and why storefront_reveal needs the real live store.
  const session = await auth();
  const { store } = await confirmStoreDraftCore(userId, { sessionInstanceId: session?.user?.sessionInstanceId });
  const baseUrl = await getBaseUrl();
  return { state: nextState, storeUrl: `${baseUrl}/store/${store.slug}`, storeName: store.name };
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

// Same enum vocabulary as app/dashboard/ai-actions.ts's ThemeSchema/
// CompositionSchema presentation+composition fields — required so this
// codebase's existing cardRadiusClass()/heroLayoutOf()/etc. resolvers work
// unchanged for these stores too. Kept as a local, condensed duplicate
// rather than an import: ai-actions.ts is itself a "use server" file, which
// can only export async functions, so its consts aren't importable here.
const CreativeThemeStructureSchema = z.object({
  presentation: z.object({
    cardStyle: z.enum(["sharp", "rounded", "soft"]),
    buttonStyle: z.enum(["sharp", "pill", "soft"]),
    shadowStyle: z.enum(["none", "subtle", "bold"]),
    spacing: z.enum(["compact", "comfortable", "spacious"]),
  }),
  composition: z.object({
    heroLayout: z.enum(["centered", "split", "fullBleed", "minimal"]),
    typeScale: z.enum(["compact", "standard", "display"]),
    sectionLayout: z.enum(["centered", "split", "boxed"]),
    backgroundTreatment: z.enum(["flat", "tintBands", "bordered"]),
    imageTreatment: z.enum(["contained", "fullBleed", "framed"]),
    ctaEmphasis: z.enum(["button", "banner", "minimal"]),
  }),
});

const CREATIVE_THEME_STRUCTURE_SYSTEM_PROMPT =
  `Choose theme.presentation and theme.composition deliberately to match this specific creative direction — ` +
  `these ten choices control the real structural shape of the storefront (card/button radius, shadow, spacing, ` +
  `hero layout, heading scale, section layout, backgrounds, image framing, and CTA emphasis), not just color. ` +
  `Sharp/flat/minimal choices suit clean or premium/luxury directions; soft/rounded/spacious choices suit playful ` +
  `or approachable ones; bold shadows and display type scale suit bold or statement directions. Make all ten ` +
  `choices feel like one coherent, deliberate aesthetic for this direction, not an arbitrary mix.`;

// Runs once fulfillment is connected (custom-design path). Picks a real
// Printful blank to print the chosen direction's artwork on — the blank is
// invisible infrastructure, not a second creative judgment (that already
// happened at direction selection), so this reuses browseCandidates'
// existing keyword ranking with no separate AI reasoning call. In
// parallel, generates the deferred presentation/composition half of the
// theme for this one chosen direction only, mirroring the exact PRIMARY/
// COMPOSITION split already proven in app/dashboard/ai-actions.ts.
export async function buildCreativeProduct(): Promise<{ state: DiscoveryState }> {
  const userId = await requireUserId();
  const draft = await getOrCreateDraft(userId);
  const state = readState(draft.onboardingState);
  if (!state.creativeDirection || !state.brandPositioning || !state.ideaText) {
    throw new Error("A creative direction must be chosen first.");
  }
  const direction = state.creativeDirection;

  const { connector } = selectFulfillmentStrategy(state.brandPositioning, getFulfillmentConnectors());

  const [candidates, structureOutcome] = await Promise.all([
    connector.browseCandidates({
      storeId: null,
      storeDraftId: draft.id,
      brandPositioning: state.brandPositioning,
      keywords: state.ideaText,
    }),
    callGenesisModel(
      {
        model: "claude-opus-4-8",
        max_tokens: 2000,
        thinking: { type: "adaptive" },
        system: CREATIVE_THEME_STRUCTURE_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: JSON.stringify({
              name: direction.name,
              description: direction.description,
              brandVoice: direction.brandVoice,
              colors: direction.colors,
            }),
          },
        ],
        output_config: { effort: "medium", format: zodOutputFormat(CreativeThemeStructureSchema) },
      },
      { userId, feature: "onboarding_creative_theme_structure" }
    ),
  ]);

  if (candidates.length === 0) {
    throw new Error("No fulfillable products were found for this catalog right now.");
  }
  const candidate = candidates[0];

  const structure = structureOutcome.ok ? structureOutcome.message.parsed_output : null;
  const existingTheme = (draft.theme as Theme | null) ?? DEFAULT_THEME;
  const nextTheme: Theme = {
    colors: direction.colors,
    typography: direction.typography,
    layout: existingTheme.layout,
    presentation: structure?.presentation ?? existingTheme.presentation ?? DEFAULT_THEME.presentation,
    composition: structure?.composition ?? existingTheme.composition ?? DEFAULT_THEME.composition,
  };
  await prisma.storeDraft.update({ where: { id: draft.id }, data: { theme: nextTheme as unknown as object } });

  const nextState = applyCandidateSelected(
    state,
    candidate,
    "Selected as the physical product this design will be printed on."
  );
  await persistState(draft.id, nextState);
  return { state: nextState };
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
    { userId, feature: "onboarding_hero_selection" }
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
export async function confirmPricing(
  retailPriceInCents?: number
): Promise<{ state: DiscoveryState; storeUrl?: string; storeName?: string }> {
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

  // Custom-design path: materialize the real Store/Product right now,
  // instead of waiting for Launch's "building" beat — this is what lets
  // storefront_reveal show the owner's actual live storefront (real
  // product, real branding, real price) rather than a summary. Once this
  // runs, app/onboarding/launch/page.tsx's own phase logic (resolveUserStore
  // finding a real Store) will automatically skip straight past the
  // commitment/building beats — verified by reading that logic directly,
  // no changes needed there. Order matters: persistState above must land
  // before this call, since confirmStoreDraftCore deletes the StoreDraft
  // row as its last internal step.
  if (nextState.creativeApproach === "custom" || nextState.creativeApproach === "upload") {
    const session = await auth();
    const { store } = await confirmStoreDraftCore(userId, { sessionInstanceId: session?.user?.sessionInstanceId });
    const baseUrl = await getBaseUrl();
    return { state: nextState, storeUrl: `${baseUrl}/store/${store.slug}`, storeName: store.name };
  }

  return { state: nextState };
}

// Experience-First Onboarding, Milestone 4 — "Let's make this real." Called
// once, right after a brand-new account is created (app/signup/page.tsx),
// while the anonymous session cookie from before signup is still present.
// Claims the matching anonymous draft for the new real user and seeds a
// real OnboardingState from the already-generated concept, landing exactly
// on fulfillment_strategy — the same state applyCreativeDirectionSelected
// already produces for the activation flow's own custom-design path, so
// everything downstream (submitFulfillmentStrategy, startFulfillmentConnect,
// buildCreativeProduct, confirmPricing/confirmSelfFulfillmentPricing,
// confirmStoreDraftCore) runs completely unchanged. No data migration, no
// re-generation — the exact same StoreDraft row just gains a real owner
// and a real onboardingState.
//
// A harmless no-op (returns null) for the ordinary "no anonymous draft"
// case — a returning visitor going straight to /signup, or anyone who
// somehow reaches signup without going through the experience flow first.
export async function claimExperienceDraft(): Promise<{ storeDraftId: string } | null> {
  const userId = await requireUserId();
  const anonymousSessionToken = await peekAnonymousSessionId();
  if (!anonymousSessionToken) return null;

  const anonymousDraft = await prisma.storeDraft.findUnique({ where: { anonymousSessionToken } });
  if (!anonymousDraft) {
    await clearAnonymousSessionCookie();
    return null;
  }

  const experienceState = readExperienceState(anonymousDraft.experienceState);
  if (experienceState.status !== "generated" || !experienceState.concept) {
    await clearAnonymousSessionCookie();
    return null;
  }
  const concept = experienceState.concept;
  const ideaText = experienceState.transcript.find((entry) => entry.role === "visitor")?.text ?? concept.productDescription;

  const claimedState: OnboardingState = {
    ...initialDiscoveryState(),
    step: "fulfillment_strategy",
    businessModelSlug: concept.businessModelSlug,
    ideaText,
    brandPositioning: concept.brandPositioning,
    brandPositioningText: ideaText,
    creativeApproach: "custom",
    creativeDirection: concept.creativeDirection,
  };

  await prisma.storeDraft.update({
    where: { id: anonymousDraft.id },
    data: {
      userId,
      anonymousSessionToken: null,
      name: concept.creativeDirection.name,
      description: concept.creativeDirection.description,
      brandPositioning: concept.brandPositioning,
      creativeDirection: concept.creativeDirection as unknown as object,
      onboardingState: claimedState as unknown as object,
    },
  });

  // AI Cost & Usage Infrastructure, Milestone 4 — the one genuinely
  // one-to-one "was this real-world output ultimately kept" signal: every
  // real AI cost incurred during this anonymous session led to a business
  // the owner decided to keep. Only touches rows still unset (outcome:
  // null) — never overwrites a real prior value — and this is the one
  // place sessionId gets populated, per the AI Cost & Usage
  // Infrastructure plan's own scoped decision.
  await prisma.aiUsageEvent.updateMany({
    where: { anonymousSessionToken, outcome: null },
    data: { outcome: "accepted", sessionId: anonymousSessionToken },
  });

  await clearAnonymousSessionCookie();
  return { storeDraftId: anonymousDraft.id };
}
