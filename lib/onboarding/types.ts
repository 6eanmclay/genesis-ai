import type { FulfillmentCandidate } from "@/lib/fulfillment/types";
import type { ThemeColors } from "@/lib/theme";
import type { PriceRecommendation } from "./pricing";

// Onboarding v2 — shared types between the pure discoveryFlow.ts state
// machine and the real persisted StoreDraft.onboardingState JSON. Kept
// separate from discoveryFlow.ts itself so app/dashboard/ai-actions.ts
// (confirmStoreDraftCore) can import just the shape, not the transition
// functions, without a needless import of fulfillment-flow orchestration
// into the file that materializes the final Store.

export type DiscoveryStep =
  | "business_model"
  | "brand_positioning"
  | "creative_approach"
  | "creative_direction_generating"
  | "creative_direction_review"
  | "artwork_upload"
  | "product_source"
  // Beta feedback (2026-08-06) — fulfillment is a real choice, never a
  // required prerequisite. Every path that used to land straight on
  // fulfillment_connect now lands here first — see discoveryFlow.ts's
  // applyFulfillmentStrategyChosen for where each answer actually goes.
  | "fulfillment_strategy"
  | "fulfillment_connect"
  | "self_fulfillment_pricing"
  | "creative_product_building"
  | "product_discovery"
  | "pricing"
  | "storefront_reveal"
  | "ready_to_publish"
  | "not_ecommerce";

// Creative Direction — the durable creative identity an owner chooses from
// Genesis's three generated directions (custom-design path only). Matches
// exactly the shape persisted to Store.creativeDirection/
// StoreDraft.creativeDirection — see that field's own schema comment.
// `colors`/`typography` reuse lib/theme.ts's own shapes so no drift is
// possible between "what a direction generates" and "what Theme accepts."
export interface CreativeDirectionOption {
  name: string;
  description: string;
  // Guidance text for future copy generation — not rendered as body copy
  // itself. Not consumed anywhere yet (a later phase's job); stored now so
  // it exists once that phase is built.
  brandVoice: string;
  // Guidance text for future image generation — same "stored now, consumed
  // later" status as brandVoice.
  photographyStyle: string;
  colors: ThemeColors;
  typography: { headingFont: string; bodyFont: string };
  logoUrl: string;
  productImageUrl: string;
}

export interface DiscoveryState {
  step: DiscoveryStep;
  businessModelSlug: string | null;
  // The owner's own words, not just the classified slug — needed so
  // Genesis's later reasoning ("you said clean and minimalist...") can
  // reference what they actually said instead of a generic template. See
  // GENESIS_EXPERIENCE.md's "Genesis understands the idea, out loud."
  ideaText: string | null;
  brandPositioning: string | null;
  brandPositioningText: string | null;
  // Which of the three real creation workflows — NOT the same fork as
  // productSource below (that one is "I already have products entirely
  // outside Printful," a different, still-deferred concept). "custom" =
  // J4 generates; "upload" = the owner supplies their own real artwork;
  // "resell" = browse the existing catalog as-is.
  creativeApproach: "custom" | "upload" | "resell" | null;
  // Ephemeral — up to 3 freshly generated options, cleared the moment one
  // is chosen. Never persisted once creativeDirection is set.
  creativeDirectionOptions: CreativeDirectionOption[] | null;
  // Durable — the owner's actual choice. Mirrors Store/StoreDraft's own
  // creativeDirection column once persisted.
  creativeDirection: CreativeDirectionOption | null;
  productSource: "existing" | "discover" | null;
  // Beta feedback (2026-08-06) — the real answer to "how do you fulfill
  // orders?", asked before any provider connection is ever attempted.
  // "printful" is the only value that ever leads to fulfillment_connect;
  // the other three all mean "no outside provider," distinguished only
  // for future Shipping & Fulfillment reporting (ARCHITECTURE.md), never
  // branched on differently today.
  fulfillmentStrategy: "printful" | "self" | "other" | "later" | null;
  selectedCandidate: FulfillmentCandidate | null;
  // Set only on the self-fulfillment path (custom/upload + a non-Printful
  // fulfillmentStrategy) — one real, owner-entered all-in cost, feeding
  // the exact same recommendPrice/applyOwnerPrice functions the Printful
  // path already uses. Mutually exclusive with selectedCandidate; never
  // both set on the same draft.
  selfSuppliedCostInCents: number | null;
  // Real, Claude-generated reasoning for why this specific candidate was
  // chosen, grounded in ideaText/brandPositioningText — never a canned
  // per-category template. Set alongside selectedCandidate. For the custom
  // path this describes why this blank was picked to print the design on,
  // not a product-fit judgment (that already happened at direction
  // selection) — see buildCreativeProduct in app/onboarding/actions.ts.
  candidateReasoning: string | null;
  fulfillmentConnected: boolean;
  pricing: PriceRecommendation | null;
}

// The real, persisted shape — DiscoveryState plus encrypted fulfillment
// OAuth credentials while no real Store/StoreIntegration exists yet to
// hold them (see ONBOARDING_V2_IMPLEMENTATION.md section 4). Keyed by
// IntegrationProvider string (e.g. "PRINTFUL") so a future second
// fulfillment connector doesn't need a new field.
export interface OnboardingState extends DiscoveryState {
  fulfillmentCredentials?: Record<string, unknown>;
}

// Experience-First Onboarding — the anonymous experience flow's own state.
// Deliberately NOT an extension of DiscoveryState/OnboardingState above:
// those belong to the activation flow's guided, multi-question wizard,
// which stays completely unmodified. The experience flow is a different
// shape on purpose — a short, conversational exchange rather than a
// sequence of fixed steps — reflecting EXPERIENCE_FIRST_ONBOARDING.md's
// "conversational, not wizard-like" principle.
//
// At claim time (the "let's make this real" step in app/onboarding/
// actions.ts), concept.creativeDirection/businessModelSlug/brandPositioning
// are copied directly into a real OnboardingState so the activation flow
// picks up exactly where this leaves off, at fulfillment_connect — see
// EXPERIENCE_FIRST_ONBOARDING.md's "activation flow" section.
export interface ExperienceTranscriptEntry {
  role: "visitor" | "genesis";
  text: string;
}

// The generated business concept — reuses CreativeDirectionOption verbatim
// (not a lookalike shape) so claiming can hand it to
// applyCreativeDirectionSelected completely unchanged. productName/
// productDescription and the cost estimate are the pieces the activation
// flow's own creative-direction step doesn't need to carry (it always has
// a real Printful-priced candidate by that point), so they live alongside
// rather than inside creativeDirection.
export interface ExperienceConcept {
  businessModelSlug: string;
  brandPositioning: string;
  creativeDirection: CreativeDirectionOption;
  productName: string;
  productDescription: string;
  pricing: PriceRecommendation;
}

export interface ExperienceState {
  transcript: ExperienceTranscriptEntry[];
  status: "collecting" | "generated";
  concept: ExperienceConcept | null;
}

// The reasoning boundary Sean asked to keep stable: every caller only ever
// sees "given the conversation so far, either ask one thing or generate a
// concept" — never the mechanics behind that decision. Today's
// implementation (decideExperienceNextStep in app/onboarding/actions.ts) is
// one structured-output model call; a future J4 reasoning engine can
// replace what's behind this boundary without changing anything that calls
// it, per Sean's explicit instruction not to hardcode onboarding logic
// we'd have to immediately tear out.
export type ExperienceDecision =
  | { action: "ask"; question: string }
  | {
      action: "generate";
      concept: {
        businessModelSlug: string;
        brandPositioning: string;
        name: string;
        description: string;
        brandVoice: string;
        photographyStyle: string;
        colors: ThemeColors;
        typography: { headingFont: string; bodyFont: string };
        logoImagePrompt: string;
        productImagePrompt: string;
        productName: string;
        productDescription: string;
        estimatedCostInCents: number;
        estimatedShippingInCents: number;
      };
    };
