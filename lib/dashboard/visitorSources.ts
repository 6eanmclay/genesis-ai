import { prisma } from "@/lib/prisma";
import { ATTRIBUTION_KINDS, type AttributionKind } from "@/lib/attribution/classify";

// WHERE THIS BUSINESS'S VISITORS CAME FROM.
//
// The attribution pipeline has recorded every storefront arrival since
// 2026-09-01 (759459b) and nothing has ever shown an owner a single row of it.
// This is the read that closes that, and MARKETING.md is the contract it
// implements — including everything it deliberately refuses to compute.
//
// ============ FOUR RULES THE PRODUCTION DATA DECIDED (2026-09-13) =======
//
// Read read-only against production with Sean's approval before any of this
// was written, because reading the code could not have settled any of them.
//
//   1. ORDERS ARE COUNTED BY attributionKind, NEVER BY attributionSource.
//      Production holds 7 attributed orders, and only 5 of them carry a
//      source — `direct_unknown` has a null source BY DESIGN (see
//      classify.ts: "The referrer host, or the explicit source token. Null
//      only for direct."). Counting on the source column undercounts by 29%
//      and reads as a bug in the recorder rather than in the query.
//
//   2. StoreVisit IS THE SOURCE OF TRUTH, NEVER StoreTrafficDay. The rollup
//      table is empty and correctly so: it is written by the retention prune,
//      the prune is dormant, and no visit is yet 12 months old. A surface
//      built on it would show zero for ever and be believed.
//
//   3. A HOST IS SHOWN AS THE HOST IT IS. Production carries facebook.com,
//      m.facebook.com, lm.facebook.com and l.facebook.com as four separate
//      rows totalling 105 visits, and they stay four rows. classify.ts states
//      the rule this obeys — "A HOST IS RECORDED AS THE HOST IT IS",
//      "linktr.ee STAYS linktr.ee" — and collapsing them here would reintroduce
//      at the read exactly the inference the recorder refuses to make.
//
//   4. THE DOMINANT KIND LEADS BECAUSE IT IS DOMINANT, not because it is
//      named. `direct_unknown` is 71% of all production traffic; ordering by
//      count puts it first without a special case, and a page that showed 152
//      referred visits while tucking 372 unattributable ones out of sight
//      would be the more flattering page and the false one.
//
// ============ AND WHAT THIS DELIBERATELY DOES NOT RETURN ================
//
// No conversion rate — visits and attributed orders are differently scoped
// populations and a ratio of them is arithmetic, not a fact. No "top channel":
// ranking implies a comparison against effort Genesis knows nothing about. No
// campaign anything: `attributionCampaign` is set on zero visits and zero
// orders in production, so a campaign section would be a promise. The caller
// gets counts and names, and builds no metric out of them.

/** One attribution kind and how many visits arrived that way. */
export interface VisitKindCount {
  kind: AttributionKind;
  visits: number;
}

/** One referring host exactly as recorded, never normalized or grouped. */
export interface VisitSourceCount {
  /** The referrer host, or the explicit tracking token. Never a full URL. */
  source: string;
  kind: AttributionKind;
  visits: number;
}

/**
 * One page visitors actually arrived on, and how many arrived there.
 *
 * ============ CAPTURED SINCE 759459b, READ BY NOTHING (2026-09-17) ======
 *
 * `StoreVisit.landingPath` has been written on every arrival since the
 * attribution pipeline shipped — 933 of them in production — and no surface
 * has ever read it. It is the only field this system holds that answers "and
 * then what", which is why it is the second half of the traffic work.
 *
 * PATH ONLY, and that is the recorder's rule rather than this one's: the
 * column's own comment says "Path only, for the same reason source is host
 * only." A landing URL would carry query strings somebody else composed.
 *
 * NOT RANKED AS PERFORMANCE. This says where arrivals landed, not which page
 * is "best" — Genesis knows nothing about what any of them cost to promote.
 */
export interface LandingPathCount {
  path: string;
  visits: number;
}

/** Orders that carry frozen attribution, by the kind and host that produced them. */
export interface OrderSourceCount {
  kind: AttributionKind;
  /** Null for `direct_unknown`, which has no source by design — not missing data. */
  source: string | null;
  orders: number;
}

export interface VisitorSources {
  /** Every visit recorded for this store. Zero is a real, established answer. */
  totalVisits: number;
  /**
   * The window the visits actually cover — not a reporting period this code
   * chose. Null only when there are no visits at all.
   */
  firstSeenAt: Date | null;
  lastSeenAt: Date | null;
  /** Descending by visits, so the dominant kind leads on its own merit. */
  byKind: VisitKindCount[];
  /** Descending by visits. Only visits that named a source appear here. */
  sources: VisitSourceCount[];
  /**
   * Where arrivals actually landed, descending by visits.
   *
   * Every visit has one, including direct ones — a visitor with no referrer
   * still landed somewhere, so unlike `sources` this list covers the whole
   * population rather than the nameable part of it.
   */
  landingPaths: LandingPathCount[];
  /** Every order this store has, attributed or not. */
  totalOrders: number;
  /** Orders carrying attributionKind. See rule 1: never counted on the source. */
  attributedOrders: number;
  /** Descending by orders. */
  orderSources: OrderSourceCount[];
}

function isAttributionKind(value: string): value is AttributionKind {
  return (ATTRIBUTION_KINDS as readonly string[]).includes(value);
}

/**
 * Read where one store's visitors came from.
 *
 * Every query is scoped to `storeId` — required, not defaulted, and enforced
 * anyway: lib/tenantIsolation.ts guards findMany/count/aggregate/groupBy on
 * this client and refuses an unscoped one outright.
 */
export async function getVisitorSources(storeId: string): Promise<VisitorSources> {
  const [window, kindRows, sourceRows, totalOrders, orderRows, landingRows] = await Promise.all([
    prisma.storeVisit.aggregate({
      where: { storeId },
      _count: { _all: true },
      _min: { firstSeenAt: true },
      _max: { lastSeenAt: true },
    }),
    prisma.storeVisit.groupBy({
      by: ["attributionKind"],
      where: { storeId },
      _count: { _all: true },
    }),
    // `source: { not: null }` is not a filter on interesting rows — it is what
    // separates "arrived from somewhere nameable" from direct traffic, which is
    // already counted in full by kindRows above. A direct visit is not missing
    // from this list; it has no host to be listed under.
    prisma.storeVisit.groupBy({
      by: ["source", "attributionKind"],
      where: { storeId, source: { not: null } },
      _count: { _all: true },
    }),
    prisma.order.count({ where: { storeId } }),
    // RULE 1. The filter and the grouping are both on attributionKind. An order
    // attributed as direct belongs in this count and carries a null source.
    prisma.order.groupBy({
      by: ["attributionKind", "attributionSource"],
      where: { storeId, attributionKind: { not: null } },
      _count: { _all: true },
    }),
    // NO `not: null` HERE, unlike sourceRows. Every visit landed somewhere,
    // including a direct one — filtering would quietly drop the majority of
    // this store's traffic from the only list that says where people went.
    prisma.storeVisit.groupBy({
      by: ["landingPath"],
      where: { storeId },
      _count: { _all: true },
    }),
  ]);

  const byKind: VisitKindCount[] = kindRows
    .filter((row) => isAttributionKind(row.attributionKind))
    .map((row) => ({ kind: row.attributionKind as AttributionKind, visits: row._count._all }))
    .sort((a, b) => b.visits - a.visits);

  const sources: VisitSourceCount[] = sourceRows
    .filter((row) => row.source !== null && isAttributionKind(row.attributionKind))
    .map((row) => ({
      source: row.source as string,
      kind: row.attributionKind as AttributionKind,
      visits: row._count._all,
    }))
    .sort((a, b) => b.visits - a.visits || a.source.localeCompare(b.source));

  const landingPaths: LandingPathCount[] = landingRows
    .map((row) => ({ path: row.landingPath, visits: row._count._all }))
    .sort((a, b) => b.visits - a.visits || a.path.localeCompare(b.path));

  const orderSources: OrderSourceCount[] = orderRows
    .filter((row) => row.attributionKind !== null && isAttributionKind(row.attributionKind))
    .map((row) => ({
      kind: row.attributionKind as AttributionKind,
      source: row.attributionSource,
      orders: row._count._all,
    }))
    .sort((a, b) => b.orders - a.orders);

  return {
    totalVisits: window._count._all,
    firstSeenAt: window._min.firstSeenAt ?? null,
    lastSeenAt: window._max.lastSeenAt ?? null,
    byKind,
    sources,
    landingPaths,
    totalOrders,
    // Summed from the same rows the breakdown is built from, so the total and
    // the list can never disagree with each other.
    attributedOrders: orderSources.reduce((sum, row) => sum + row.orders, 0),
    orderSources,
  };
}

/**
 * What each kind means, in the owner's language.
 *
 * Plain descriptions of the evidence, never a guess at the platform behind it.
 * `direct_unknown` says that no source was available rather than implying the
 * visitor typed the address in — Genesis does not know that either.
 */
export const ATTRIBUTION_KIND_LABELS: Record<AttributionKind, string> = {
  explicit_tracking: "From a link with tracking",
  observed_referral: "From another site",
  direct_unknown: "No source recorded",
};
