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
// Deliberately empty today, same discipline as growthCreditCatalog.ts:
// real point costs are Sean's own product-strategy decision for a
// dedicated design session (business value, economy psychology, real usage
// data — never AI cost alone), not something to invent during
// implementation. The full mechanism (lib/execution/engine.ts's balance
// check and deduction, the monthly refresh, referral rewards) is real and
// live; only the numbers are missing on purpose. An action with no entry
// here costs nothing to execute — the same "honest null" behavior every
// other catalog in this codebase already has.
const GROWTH_POINT_CATALOG: Partial<Record<GenesisActionType, number>> = {};

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
