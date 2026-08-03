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
import { GeneratedImageProvider } from "@/lib/imageProviders/generatedImageProvider";
import { confirmStoreDraftCore } from "@/app/dashboard/ai-actions";
import {
  initialDiscoveryState,
  applyBusinessModelAnswer,
  applyBrandPositioningAnswer,
  applyCreativeApproachAnswer,
  applyCreativeDirectionsGenerated,
  applyCreativeDirectionSelected,
  applyProductSourceAnswer,
  applyCandidateSelected,
  applyPricingConfirmed,
} from "@/lib/onboarding/discoveryFlow";
import type { CreativeDirectionOption, DiscoveryState, OnboardingState } from "@/lib/onboarding/types";
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
  return prisma.storeDraft.create({
    data: { userId, name: "New store", status: "onboarding_discovery" },
  });
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

// Custom-design vs. reselling/curating a blank as-is — a lightweight,
// no-AI-call binary choice, same shape as submitProductSourceAnswer below.
export async function submitCreativeApproachAnswer(
  approach: "custom" | "resell"
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
    { userId }
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
        }),
        GeneratedImageProvider.source({
          prompt: direction.logoImagePrompt,
          name: `${direction.name} logo`,
          description: direction.description,
          excludeUrls: [],
          scope: { userId },
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
      { userId }
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
  if (nextState.creativeApproach === "custom") {
    const session = await auth();
    const { store } = await confirmStoreDraftCore(userId, { sessionInstanceId: session?.user?.sessionInstanceId });
    const baseUrl = await getBaseUrl();
    return { state: nextState, storeUrl: `${baseUrl}/store/${store.slug}`, storeName: store.name };
  }

  return { state: nextState };
}
