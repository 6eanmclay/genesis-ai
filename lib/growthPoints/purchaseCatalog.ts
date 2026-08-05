// Chapter 5 (Payments) — the real "buy Growth Points directly" package
// list, mirroring lib/growthPoints/catalog.ts's own discipline exactly:
// which tiers exist, how many points each grants, and what they cost are
// all Sean's own product decision (economy psychology, real usage data),
// not something to invent during implementation. Deliberately empty today
// — the full mechanism (checkout session creation, webhook crediting) is
// real and live; only the packages themselves are missing on purpose. The
// owner-facing UI only ever renders an entry once it has a real
// stripePriceId — a package without one is exactly as "not offered yet" as
// an unpriced GENESIS_ACTIONS actionType is today.
export interface GrowthPointPackage {
  label: string;
  pointAmount: number;
  stripePriceId: string | null;
}

const GROWTH_POINT_PURCHASE_CATALOG: Record<string, GrowthPointPackage> = {};

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
