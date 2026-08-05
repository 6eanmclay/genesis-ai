import type { GenesisActionType } from "@/lib/execution/genesisActions";

// Growth Points Economy (Chapter 2, VISION.md) — the real customer-facing
// price list, keyed by GENESIS_ACTIONS' actionType strings (Sean's explicit
// decision, 2026-08-04): a Growth Point represents a real business outcome
// ("Create a Product," "Improve SEO"), never an internal AI-call mechanic.
// This is a genuinely different axis from lib/growthCreditCatalog.ts, which
// stays keyed by AiFeature — that file is the internal AI-cost-observability
// ledger (feeds AiUsageEvent.growthCreditValue, never shown to an owner);
// this one is the economy an owner actually spends against
// (GrowthPointTransaction, via lib/execution/engine.ts). Resolves the
// taxonomy question flagged in genesisActions.ts: GENESIS_ACTIONS is the
// vocabulary the customer-facing catalog uses.
//
// Real, locked catalog — frozen by Sean 2026-08-05 (ARCHITECTURE.md's
// "Growth Points measure business significance, not technical difficulty").
// Every tier here is a judgment about how much of the business a real
// action moves, never how much engineering/AI work it took to build —
// create_product's real $0.17 gpt-image-1 cost happens to correlate with
// its tier; update_theme's zero direct cost deliberately doesn't stop it
// from being priced at the top. Real AiUsageEvent cost is a sanity-check
// floor, never the basis for a price.
//
// update_goal_status, resolve_challenge, and communicate_finding are
// deliberately ABSENT, not priced at 0 — they're bookkeeping/communication,
// not a change to the business, and lib/execution/engine.ts only calls
// deductGrowthPoints when growthPointCostFor returns non-null. An explicit
// 0 would still write a real "Invested in..." transaction row on every one
// of these (frequent, low-stakes) actions — absence is what keeps them
// genuinely free and silent, exactly like every other unpriced action.
//
// update_marketing_assets sits at the "campaign creation" tier because
// that's the one real thing it currently does (draft real brand-voice
// content). Sean's own expectation: this forks into several real, more
// specifically priced actions once Marketing Engine M3+ builds the
// broader capability (video analysis, scheduling, platform adaptation) —
// not built now, staying one action until there's a real reason to split.
const GROWTH_POINT_CATALOG: Partial<Record<GenesisActionType, number>> = {
  // 1pt — narrow, single-concern, routine maintenance (Business Partner's
  // unlimited tier).
  update_seo: 1,
  update_product_image: 1,
  update_section_order: 1,
  // 2pt — real creation or a moderate content change.
  create_product: 2,
  update_hero: 2,
  update_homepage_content: 2,
  update_store_content: 2,
  // 3pt — strategic moves.
  update_store_identity: 3,
  update_design_direction: 3,
  update_marketing_assets: 3,
  // 5pt — whole-brand transformation.
  update_theme: 5,
  update_brand_identity: 5,
};

export function growthPointCostFor(actionType: GenesisActionType): number | null {
  return GROWTH_POINT_CATALOG[actionType] ?? null;
}

// Shared by both real reasoning surfaces that need to show J4 a real cost
// table — lib/intelligence/cognitiveLayer.ts's Reason pass and chat's own
// data-answer context (app/dashboard/ai-actions.ts) — so both build the
// identical honest lookup (only actionTypes with a real, non-null price
// appear at all) rather than two independently-maintained copies.
export function growthPointCostsFor(
  actionTypes: readonly GenesisActionType[]
): Partial<Record<GenesisActionType, number>> {
  return Object.fromEntries(
    actionTypes
      .map((actionType): [GenesisActionType, number | null] => [actionType, growthPointCostFor(actionType)])
      .filter((entry): entry is [GenesisActionType, number] => entry[1] !== null)
  );
}
