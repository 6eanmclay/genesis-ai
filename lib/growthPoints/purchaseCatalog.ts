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
// stripePriceId is populated by scripts/provision-pricing.ts against
// Stripe's real sandbox — null here until that script has run.
const GROWTH_POINT_PURCHASE_CATALOG: Record<string, GrowthPointPackage> = {
  pack_4: { label: "4 Growth Points", pointAmount: 4, stripePriceId: "price_1U16bJBo3H6St4fl1pVnA3ld", priceInCents: 999 },
  pack_8: { label: "8 Growth Points", pointAmount: 8, stripePriceId: "price_1U16bKBo3H6St4fl5giNboiY", priceInCents: 1999 },
  pack_20: { label: "20 Growth Points", pointAmount: 20, stripePriceId: "price_1U16bKBo3H6St4flAYfFSirU", priceInCents: 4999 },
  pack_45: { label: "45 Growth Points", pointAmount: 45, stripePriceId: "price_1U16bLBo3H6St4flBHEVlZb1", priceInCents: 9999 },
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
