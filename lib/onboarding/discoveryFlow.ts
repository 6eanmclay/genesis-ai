import type { FulfillmentCandidate } from "@/lib/fulfillment/types";
import type { PriceRecommendation } from "./pricing";
import type { DiscoveryState, DiscoveryStep } from "./types";

export type { DiscoveryState, DiscoveryStep };

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

// Goes straight to fulfillment_connect, skipping product_source — Sean's
// explicit scope for this build pass is the single "help me find something
// to sell" path, "one polished path" rather than multiple partial ones
// (ONBOARDING_V2_DESIGN.md's "I have products" branch stays deferred).
// applyProductSourceAnswer below still exists, ready for when that branch
// is actually built — it's just not reached from the real UI yet.
export function applyBrandPositioningAnswer(
  state: DiscoveryState,
  brandPositioning: string,
  brandPositioningText: string
): DiscoveryState {
  return { ...state, brandPositioning, brandPositioningText, productSource: "discover", step: "fulfillment_connect" };
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
  return { ...state, fulfillmentConnected: true, step: "product_discovery" };
}

export function applyCandidateSelected(
  state: DiscoveryState,
  candidate: FulfillmentCandidate,
  reasoning: string
): DiscoveryState {
  return { ...state, selectedCandidate: candidate, candidateReasoning: reasoning, step: "pricing" };
}

export function applyPricingConfirmed(state: DiscoveryState, pricing: PriceRecommendation): DiscoveryState {
  return { ...state, pricing, step: "ready_to_publish" };
}
