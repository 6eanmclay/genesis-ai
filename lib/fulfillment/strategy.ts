import { brandPositioningLabel } from "@/lib/businessTaxonomy";
import type { BrandPositioningSlug, FulfillmentConnector, FulfillmentPartnerProfile } from "./types";
import { getFulfillmentConnectors } from "./registry";

// Onboarding v2 — the layer that makes "the owner never chooses a
// fulfillment provider" literally true (ONBOARDING_V2_DESIGN.md section 6).
// Real scoring logic is genuinely trivial with one registered connector,
// but the function signature and call site don't change when a second one
// is added — that's the point of building this now rather than hardcoding
// Printful directly into the onboarding flow.

const QUALITY_SCORE: Record<FulfillmentPartnerProfile["qualityTier"], number> = {
  premium: 1,
  standard: 0,
};

function scoreFit(profile: FulfillmentPartnerProfile, brandPositioning: BrandPositioningSlug): number {
  const brandFitScore = profile.brandFit.includes(brandPositioning) ? 2 : 0;
  return brandFitScore + QUALITY_SCORE[profile.qualityTier];
}

function explainFit(profile: FulfillmentPartnerProfile, brandPositioning: BrandPositioningSlug): string {
  const positioningLabel = brandPositioningLabel(brandPositioning).toLowerCase();
  const quality = profile.qualityTier === "premium" ? "a premium, quality-focused" : "a reliable, straightforward";
  return `${quality} option that fits a ${positioningLabel} brand, with no upfront inventory cost.`;
}

export interface FulfillmentStrategy {
  connector: FulfillmentConnector;
  rationale: string;
}

export function selectFulfillmentStrategy(
  brandPositioning: BrandPositioningSlug,
  connectors: FulfillmentConnector[] = getFulfillmentConnectors()
): FulfillmentStrategy {
  if (connectors.length === 0) {
    throw new Error("No fulfillment connectors are registered.");
  }
  const scored = connectors
    .map((connector) => ({ connector, fit: scoreFit(connector.profile, brandPositioning) }))
    .sort((a, b) => b.fit - a.fit);
  const best = scored[0];
  return { connector: best.connector, rationale: explainFit(best.connector.profile, brandPositioning) };
}
