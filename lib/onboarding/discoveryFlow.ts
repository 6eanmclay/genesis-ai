import type { FulfillmentCandidate } from "@/lib/fulfillment/types";
import type { PriceRecommendation } from "./pricing";
import type { CreativeDirectionOption, DiscoveryState, DiscoveryStep } from "./types";

export type { CreativeDirectionOption, DiscoveryState, DiscoveryStep };

// Onboarding v2 — the guided discovery flow's own pure state machine.
// Given the current state and an already-classified/already-fetched
// answer, computes the next step. No I/O anywhere in this file — every
// function that needs a real AI classification call or a real fulfillment
// API call lives in app/onboarding/actions.ts, which calls these pure
// transitions with the result. Mirrors the existing genesisArrivalCopy.ts
// pattern (pure function, given inputs, returns a plan) already proven
// elsewhere in this codebase.
//
// This module knows nothing about Printful, or about fulfillment
// specifically — see ONBOARDING_V2_DESIGN.md section 11's standing
// principle: fulfillment is the ecommerce path's own execution strategy,
// invoked from step "product_discovery"/"fulfillment_connect" below, never
// imported into this file. A future non-ecommerce path would add its own
// steps the same way, without this file needing to know what a
// FulfillmentCandidate is either — the one import above is a pragmatic
// concession for the one path this pass actually builds, not a sign this
// module is fulfillment-shaped.

export function initialDiscoveryState(): DiscoveryState {
  return {
    step: "business_model",
    businessModelSlug: null,
    ideaText: null,
    brandPositioning: null,
    brandPositioningText: null,
    creativeApproach: null,
    creativeDirectionOptions: null,
    creativeDirection: null,
    productSource: null,
    selectedCandidate: null,
    candidateReasoning: null,
    fulfillmentConnected: false,
    pricing: null,
  };
}

// Only these two revenue-stream slugs get the ecommerce path — see
// ONBOARDING_V2_DESIGN.md section 4's table. Every other classification
// (including "other") falls back to today's existing flow.
const ECOMMERCE_SLUGS = new Set(["product_sales", "digital_products"]);

export function applyBusinessModelAnswer(state: DiscoveryState, businessModelSlug: string, ideaText: string): DiscoveryState {
  if (!ECOMMERCE_SLUGS.has(businessModelSlug)) {
    return { ...state, businessModelSlug, ideaText, step: "not_ecommerce" };
  }
  return { ...state, businessModelSlug, ideaText, step: "brand_positioning" };
}

// Goes to creative_approach — Sean's explicit scope for this build pass is
// the single "help me find something to sell" path plus the new custom-
// design fork, "one polished path (times two)" rather than multiple
// partial ones (ONBOARDING_V2_DESIGN.md's "I have products" branch, a
// DIFFERENT fork from creativeApproach below, stays deferred).
// applyProductSourceAnswer further below still exists, ready for when that
// separate branch is actually built — it's just not reached from the real
// UI yet.
export function applyBrandPositioningAnswer(
  state: DiscoveryState,
  brandPositioning: string,
  brandPositioningText: string
): DiscoveryState {
  return { ...state, brandPositioning, brandPositioningText, step: "creative_approach" };
}

// custom -> generate three creative directions; upload -> the owner
// supplies their own real artwork; resell -> today's existing
// catalog-browse-and-pick flow, completely unchanged from here on.
export function applyCreativeApproachAnswer(
  state: DiscoveryState,
  creativeApproach: "custom" | "upload" | "resell"
): DiscoveryState {
  if (creativeApproach === "resell") {
    return { ...state, creativeApproach, productSource: "discover", step: "fulfillment_connect" };
  }
  if (creativeApproach === "upload") {
    return { ...state, creativeApproach, step: "artwork_upload" };
  }
  return { ...state, creativeApproach, step: "creative_direction_generating" };
}

export function applyCreativeDirectionsGenerated(
  state: DiscoveryState,
  directions: CreativeDirectionOption[]
): DiscoveryState {
  return { ...state, creativeDirectionOptions: directions, step: "creative_direction_review" };
}

export function applyCreativeDirectionSelected(
  state: DiscoveryState,
  chosen: CreativeDirectionOption
): DiscoveryState {
  return { ...state, creativeDirection: chosen, creativeDirectionOptions: null, step: "fulfillment_connect" };
}

// The upload path skips "review 3 options" entirely — one real upload
// produces one real direction, so it lands on the exact same destination
// applyCreativeDirectionSelected already uses.
export function applyArtworkUploaded(
  state: DiscoveryState,
  direction: CreativeDirectionOption
): DiscoveryState {
  return { ...state, creativeDirection: direction, step: "fulfillment_connect" };
}

export function applyProductSourceAnswer(
  state: DiscoveryState,
  productSource: "existing" | "discover"
): DiscoveryState {
  // "I already have products" skips fulfillment connect/discovery entirely
  // — the owner supplies their own cost, straight to the pricing step.
  if (productSource === "existing") {
    return { ...state, productSource, step: "pricing" };
  }
  return { ...state, productSource, step: "fulfillment_connect" };
}

export function applyFulfillmentConnected(state: DiscoveryState): DiscoveryState {
  // Backward-compatible by construction: any in-flight draft with
  // creativeApproach still null/undefined (created before this fork
  // existed) falls through to today's exact existing behavior
  // (product_discovery) — same as "resell". Both "custom" and "upload"
  // need the same next step: a real blank still has to be picked and a
  // real theme structure still has to be generated, regardless of whether
  // the artwork itself was Genesis-generated or the owner's own upload.
  const needsCreativeProduct = state.creativeApproach === "custom" || state.creativeApproach === "upload";
  const step = needsCreativeProduct ? "creative_product_building" : "product_discovery";
  return { ...state, fulfillmentConnected: true, step };
}

export function applyCandidateSelected(
  state: DiscoveryState,
  candidate: FulfillmentCandidate,
  reasoning: string
): DiscoveryState {
  return { ...state, selectedCandidate: candidate, candidateReasoning: reasoning, step: "pricing" };
}

export function applyPricingConfirmed(state: DiscoveryState, pricing: PriceRecommendation): DiscoveryState {
  // Custom and upload both land on storefront_reveal instead of handing
  // off to Launch directly — see confirmPricing in app/onboarding/
  // actions.ts, which materializes the real Store right after this
  // transition for either path. Resell (and any pre-Creative-Direction
  // in-flight draft) keeps today's exact existing behavior.
  const hasCreativeDirection = state.creativeApproach === "custom" || state.creativeApproach === "upload";
  const step = hasCreativeDirection ? "storefront_reveal" : "ready_to_publish";
  return { ...state, pricing, step };
}
