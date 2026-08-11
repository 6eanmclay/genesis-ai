// Chapter 5 (Payments) — the real "buy Growth Points directly" package
// list, mirroring lib/growthPoints/catalog.ts's own discipline exactly:
// which tiers exist, how many points each grants, and what they cost are
// all Sean's own product decision (economy psychology, real usage data),
// not something to invent during implementation. The owner-facing UI only
// ever renders an entry once it has a real stripePriceId — a package
// without one is exactly as "not offered yet" as an unpriced
// GENESIS_ACTIONS actionType is today.
export interface GrowthPointPackage {
  label: string;
  pointAmount: number;
  stripePriceId: string | null;
  // Display only, same discipline as Plan.priceInCents — Stripe's own
  // Price stays authoritative at checkout time.
  priceInCents: number | null;
}

// Real initial à la carte pricing, frozen 2026-08-05 (see ARCHITECTURE.md's
// "Growth Points Economy — initial real pricing" section). Deliberately
// priced slightly above the equivalent per-point subscription rate so a
// one-off pack never quietly out-values committing to a plan.
// stripePriceId is populated by scripts/provision-pricing.ts.
//
// These are LIVE-mode Price IDs on acct_1TuhvRBDW1ilB8Vd (the real Genesis
// account), provisioned 2026-08-11 — they replaced the original sandbox
// IDs, which had been unreachable in production since Aug 2 the moment
// STRIPE_SECRET_KEY there became a live key. Every one of them fails
// against a test-mode key, so a local dev run pointed at the sandbox will
// now correctly error on a Growth Point purchase rather than silently
// charging in the wrong mode.
//
// Per-point rates here ($2.50, or $2.22 on the 45-pack) are deliberately
// the WORST in the economy: every subscription tier in scripts/
// provision-pricing.ts beats them ($2.00 Starter, $1.79 Growth), which is
// the property that makes committing to a plan rational. Repricing a pack
// below $2.22/pt would break that and needs the plan ladder re-checked
// alongside it.
const GROWTH_POINT_PURCHASE_CATALOG: Record<string, GrowthPointPackage> = {
  pack_4: { label: "4 Growth Points", pointAmount: 4, stripePriceId: "price_1U3LobBDW1ilB8VdfgQ2baiS", priceInCents: 999 },
  pack_8: { label: "8 Growth Points", pointAmount: 8, stripePriceId: "price_1U3LobBDW1ilB8VdTJsRLpI9", priceInCents: 1999 },
  pack_20: { label: "20 Growth Points", pointAmount: 20, stripePriceId: "price_1U3LocBDW1ilB8Vd9zDPL5Y6", priceInCents: 4999 },
  pack_45: { label: "45 Growth Points", pointAmount: 45, stripePriceId: "price_1U3LocBDW1ilB8VdE4KNOPqg", priceInCents: 9999 },
};

// Only entries with a real, non-null Stripe Price — same "honest null"
// convention growthPointCostFor already uses.
export function growthPointPackages(): [string, GrowthPointPackage][] {
  return Object.entries(GROWTH_POINT_PURCHASE_CATALOG).filter(
    (entry): entry is [string, GrowthPointPackage & { stripePriceId: string }] => entry[1].stripePriceId !== null
  );
}

export function growthPointPackage(key: string): (GrowthPointPackage & { stripePriceId: string }) | null {
  const pkg = GROWTH_POINT_PURCHASE_CATALOG[key];
  return pkg && pkg.stripePriceId !== null ? (pkg as GrowthPointPackage & { stripePriceId: string }) : null;
}
