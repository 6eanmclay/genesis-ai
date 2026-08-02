import type { FulfillmentCandidate } from "@/lib/fulfillment/types";
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
  | "product_source"
  | "fulfillment_connect"
  | "product_discovery"
  | "pricing"
  | "ready_to_publish"
  | "not_ecommerce";

export interface DiscoveryState {
  step: DiscoveryStep;
  businessModelSlug: string | null;
  brandPositioning: string | null;
  productSource: "existing" | "discover" | null;
  selectedCandidate: FulfillmentCandidate | null;
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
