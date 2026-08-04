import type { AiFeature } from "./aiFeatures";

// AI Cost & Usage Infrastructure — where a future Growth Credit VALUE gets
// assigned per action, kept in its own file specifically so it's obvious
// this is a completely separate axis from lib/aiPricing.ts's operational
// cost calculators (Sean's explicit principle, 2026-08-04: real API cost
// and business value are independently configurable — an action's Growth
// Credit price should be a deliberate product decision, never a byproduct
// of what tokens/images happened to cost).
//
// Deliberately empty today. Growth Credits aren't live — no feature has a
// real assigned value yet, and every one of those is Sean's own product
// decision to make (e.g. "Create a New Product" staying a 2-credit action
// even if the underlying image-generation cost changes materially — his
// own example). Populating this later needs no schema change and no
// change anywhere else in this system: recordGrowthCreditValue below
// already reads from here, wired all the way through to
// AiUsageEvent.growthCreditValue, and will simply start returning real
// numbers the moment entries are added.
//
// "Thinking is free, execution is invested" (Sean, 2026-08-04, frozen as a
// standing product principle — see ARCHITECTURE.md's own section) governs
// the SHAPE of every future entry here: a feature that only ever informs,
// explains, plans, or reasons — never assigned a nonzero value here,
// regardless of its real operational cost in lib/aiPricing.ts. Only a
// feature whose call site sits inside a registered Executable's own run()
// (something that actually changes or grows the business, gated behind a
// real owner approval) may ever get a real Growth Credit price. Which
// exact AiFeature values fall on which side of that line is still real,
// unresolved classification work — most are obvious, a few (e.g. the
// store-generation calls that produce a real deliverable directly, with no
// separate approval step today) genuinely aren't yet — left undecided here
// on purpose, not defaulted either way.
const GROWTH_CREDIT_CATALOG: Partial<Record<AiFeature, number>> = {};

export function growthCreditValueFor(feature: AiFeature): number | null {
  return GROWTH_CREDIT_CATALOG[feature] ?? null;
}
