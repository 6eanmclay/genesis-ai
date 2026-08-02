import type { BrandPositioningSlug } from "@/lib/fulfillment/types";

// Onboarding v2 — brand-aware default pricing, not a flat universal
// margin. ONBOARDING_V2_DESIGN.md section 7: a luxury/professional
// positioning supports a materially different margin than a budget/family
// one against the identical underlying cost.
//
// The exact percentages below are PLACEHOLDER pricing content, not a
// frozen architectural decision — ONBOARDING_V2_DESIGN.md section 10 item
// 5 leaves the real bands as an open item for Sean once implementation
// reaches this function, and ONBOARDING_V2_IMPLEMENTATION.md section 10
// says the same. Kept here, named and commented as placeholders, so the
// function is real and testable now rather than blocking on a number that
// isn't architecture. Bands anchored loosely between the real validated
// Printful test (~30%) and Sean's own earlier example (cost $18 -> price
// $29.99, ~40%) — not invented from nothing.
const MARGIN_BAND_BY_POSITIONING: Record<string, number> = {
  luxury: 0.5,
  professional: 0.4,
  streetwear: 0.35,
  minimalist: 0.35,
  family: 0.3,
  budget: 0.25,
  other: 0.35,
};

const DEFAULT_MARGIN = 0.35;

export interface PriceRecommendation {
  retailPriceInCents: number;
  profitInCents: number;
  marginPct: number;
}

// Margin here is profit / retailPrice (not markup over cost) — matches how
// the recommendation is narrated to the owner ("you keep 35% of every
// sale"), and matches Printful's own draft-order profit figure, which this
// function's output is meant to be consistent with.
export function recommendPrice(
  costInCents: number,
  shippingInCents: number,
  brandPositioning: BrandPositioningSlug
): PriceRecommendation {
  const totalCostInCents = costInCents + shippingInCents;
  const marginPct = MARGIN_BAND_BY_POSITIONING[brandPositioning] ?? DEFAULT_MARGIN;
  const retailPriceInCents = Math.round(totalCostInCents / (1 - marginPct));
  const profitInCents = retailPriceInCents - totalCostInCents;
  return { retailPriceInCents, profitInCents, marginPct };
}

// The owner's own explicit override — fixed amount, percentage, or fully
// custom all reduce to "here's the final price," computed the same way
// regardless of which UI control produced it.
export function applyOwnerPrice(costInCents: number, shippingInCents: number, retailPriceInCents: number): PriceRecommendation {
  const totalCostInCents = costInCents + shippingInCents;
  const profitInCents = retailPriceInCents - totalCostInCents;
  const marginPct = retailPriceInCents > 0 ? profitInCents / retailPriceInCents : 0;
  return { retailPriceInCents, profitInCents, marginPct };
}
