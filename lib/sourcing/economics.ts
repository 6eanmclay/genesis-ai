import { prisma } from "@/lib/prisma";
import type { EconomicsProvenance } from "@prisma/client";
import { isOwnerCapability, type OwnerCapability } from "./methodProfile";
import { toVariantKey } from "./types";
import {
  currentFreshnessPolicy,
  freshnessOf,
  type EconomicsFreshnessPolicy,
  type Freshness,
} from "./economicsPolicy";

// WHAT A SUPPLIER'S PRODUCT COSTS — the layer the progression engine was waiting
// for.
//
// The engine can reason about minimums, bulk pricing, margins and payback. In
// production none of it fired, because nothing knew what anything cost: no
// supplier API this platform can reach states bulk pricing, and the honest
// consequence was `cannot_assess` on every deepen.
//
// This does not fix that by inventing numbers. It gives the numbers somewhere to
// live, three ways for them to arrive, and one way to say they are not available
// — and the most immediately useful of the three needs no API at all: the owner
// rings the supplier and tells Genesis what they said.
//
// THIS FILE READS. `economicsIngest.ts` is the only thing that writes.

/** A price break. */
export interface PriceTier {
  minUnits: number;
  unitCostInCents: number;
}

/**
 * Whether the stored tier data can be believed.
 *
 * A separate state from "no tiers", and the distinction is the whole point.
 * Tiers that did not parse used to fall through to the flat figures, so a
 * corrupt price-break table produced a confident-looking unit price with no
 * indication anything was wrong. A plausible figure derived from data we have
 * just established is broken is worse than no figure at all.
 */
export type TierIntegrity = { ok: true } | { ok: false; problem: string };

/**
 * Everything known about what one supplier's product costs this business.
 *
 * Every figure nullable, and null means UNKNOWN throughout. Nothing here is ever
 * defaulted, averaged, or derived from a percentage of something else.
 */
export interface SupplierEconomics {
  sourceKey: string;
  externalProductId: string;
  externalVariantId: string | null;
  provenance: EconomicsProvenance;
  /** What currency these figures are in. Stated, never assumed. */
  currency: string;
  unitCostInCents: number | null;
  minimumOrderUnits: number | null;
  /** Null when none were stated OR when what was stored is unusable — see `integrity`. */
  tiers: PriceTier[] | null;
  integrity: TierIntegrity;
  shippingPerUnitInCents: number | null;
  leadTimeDays: number | null;
  requiresCapabilities: OwnerCapability[];
  /**
   * Who said so, when a person did.
   *
   * Exposed on the read shape because an owner-provided figure is only worth
   * more than a catalogue's if it can be attributed back when it is questioned.
   * Null for a connector sync, which had no person behind it.
   */
  statedByUserId: string | null;
  statedAt: Date;
  freshness: Freshness;
  note: string | null;
}

/** How this product's identity is written, and it is always all four parts. */
export interface SupplierProductRef {
  sourceKey: string;
  externalProductId: string;
  externalVariantId: string | null;
}

// --- tier validation --------------------------------------------------------

/**
 * Why a set of price breaks cannot be used, or null if it can.
 *
 * Shared by the writer and the reader deliberately. The writer rejects bad tiers
 * at the boundary; the reader still has to cope with them, because rows can
 * arrive from an import, a migration, or a connector written before this
 * existed. Validating in one place means the two can never disagree about what
 * "valid" means.
 *
 * NOT VALIDATED: whether a bigger order costs less per unit. A supplier quoting
 * 500 at a HIGHER unit price than 100 is odd but not contradictory — nobody
 * would buy at that tier, and `bulkTerms` picking the cheapest is still the
 * right answer. Rejecting it would be Genesis deciding it knows the supplier's
 * business better than the supplier does.
 */
export function tierProblem(tiers: PriceTier[]): string | null {
  const seen = new Set<number>();
  for (const tier of tiers) {
    if (!Number.isInteger(tier.minUnits) || tier.minUnits < 1) {
      return `a price break for ${JSON.stringify(tier.minUnits)} units, which is not a quantity anybody can order`;
    }
    if (!Number.isInteger(tier.unitCostInCents) || tier.unitCostInCents < 0) {
      return `a price of ${JSON.stringify(tier.unitCostInCents)} at ${tier.minUnits} units, which is not a price`;
    }
    // TWO PRICES FOR THE SAME QUANTITY. This is the true contradiction: there is
    // no way to know which one an order of that size would be charged, and
    // picking either is picking a number about somebody's money at random.
    if (seen.has(tier.minUnits)) {
      return `two different prices for the same quantity (${tier.minUnits} units)`;
    }
    seen.add(tier.minUnits);
  }
  return null;
}

type TierRead = { tiers: PriceTier[] | null; integrity: TierIntegrity };

/**
 * Read stored tiers, and say plainly when they cannot be read.
 *
 * Never throws and never guesses. An unusable record resolves to no tiers AND a
 * problem, and it is the problem — not the absence — that the rest of the
 * pipeline acts on.
 */
export function readTiers(value: unknown): TierRead {
  if (value === null || value === undefined) return { tiers: null, integrity: { ok: true } };
  if (!Array.isArray(value)) {
    return { tiers: null, integrity: { ok: false, problem: "the price breaks aren't a list" } };
  }

  const tiers: PriceTier[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return {
        tiers: null,
        integrity: { ok: false, problem: "a price break that isn't a quantity and a price" },
      };
    }
    const raw = entry as Record<string, unknown>;
    if (typeof raw.minUnits !== "number" || !Number.isFinite(raw.minUnits)) {
      return { tiers: null, integrity: { ok: false, problem: "a price break with no usable quantity" } };
    }
    if (typeof raw.unitCostInCents !== "number" || !Number.isFinite(raw.unitCostInCents)) {
      return { tiers: null, integrity: { ok: false, problem: `no usable price at ${raw.minUnits} units` } };
    }
    tiers.push({ minUnits: raw.minUnits, unitCostInCents: raw.unitCostInCents });
  }

  const problem = tierProblem(tiers);
  if (problem) return { tiers: null, integrity: { ok: false, problem } };

  // An empty array is valid and means "this supplier has no price breaks",
  // which is different from "nobody recorded any".
  return {
    tiers: tiers.sort((a, b) => a.minUnits - b.minUnits),
    integrity: { ok: true },
  };
}

// --- reading ----------------------------------------------------------------

/**
 * What this business knows about one supplier product.
 *
 * Scoped by all four identity parts. A row for the same external id under a
 * different source is a different product and is never returned here — that
 * collision is the one this table's unique key exists to make impossible.
 */
export async function supplierEconomics(
  storeId: string,
  ref: SupplierProductRef,
  options: { now?: Date; freshnessPolicy?: EconomicsFreshnessPolicy } = {}
): Promise<SupplierEconomics | null> {
  const row = await prisma.supplierEconomics.findFirst({
    where: {
      storeId,
      sourceKey: ref.sourceKey,
      externalProductId: ref.externalProductId,
      externalVariantId: toVariantKey(ref.externalVariantId),
    },
  });
  if (!row) return null;

  const { tiers, integrity } = readTiers(row.tiers);

  return {
    sourceKey: row.sourceKey,
    externalProductId: row.externalProductId,
    externalVariantId: row.externalVariantId === "" ? null : row.externalVariantId,
    provenance: row.provenance,
    currency: row.currency,
    unitCostInCents: row.unitCostInCents,
    minimumOrderUnits: row.minimumOrderUnits,
    tiers,
    integrity,
    shippingPerUnitInCents: row.shippingPerUnitInCents,
    leadTimeDays: row.leadTimeDays,
    requiresCapabilities: row.requiresCapabilities.filter(isOwnerCapability),
    statedByUserId: row.statedByUserId,
    statedAt: row.statedAt,
    freshness: freshnessOf(
      row.provenance,
      row.statedAt,
      options.now ?? new Date(),
      options.freshnessPolicy ?? currentFreshnessPolicy()
    ),
    note: row.note,
  };
}

/**
 * Everything the feasibility check needs about a supplier, in one shape.
 *
 * One type flows from the database through graduation into `assessFeasibility`
 * and out into what the owner reads, so a fact cannot be silently dropped on the
 * way — which is exactly what happened to shipping, lead time and per-product
 * capabilities for the first fortnight of this table's life.
 */
export interface SupplierTerms {
  minimumOrderUnits: number | null;
  bulkUnitCostInCents: number | null;
  /** Per unit, on the bulk order. Null = unknown. A stated 0 means "included". */
  shippingPerUnitInCents: number | null;
  leadTimeDays: number | null;
  /** Demanded by THIS product, beyond whatever its method demands. */
  requiresCapabilities: OwnerCapability[];
  /** Null when nothing has ever been recorded for this product. */
  provenance: EconomicsProvenance | null;
  /**
   * The currency the figures above are in, or null when nothing was recorded.
   *
   * Carried all the way to `assessFeasibility` so it can refuse to compare a
   * supplier's EUR quote against a business that sells in USD. Nothing in this
   * codebase converts currency, and a figure whose currency was assumed is a
   * wrong number about money that looks exactly like a right one.
   */
  currency: string | null;
  freshness: Freshness | null;
  integrity: TierIntegrity;
}

export const NO_TERMS: SupplierTerms = {
  minimumOrderUnits: null,
  bulkUnitCostInCents: null,
  shippingPerUnitInCents: null,
  leadTimeDays: null,
  requiresCapabilities: [],
  provenance: null,
  currency: null,
  freshness: null,
  integrity: { ok: true },
};

/**
 * The bulk terms a feasibility check needs, resolved from tiers or flat figures.
 *
 * Returns nulls rather than guesses. A supplier that published a unit price but
 * no minimum has told us one thing and not the other, and pretending the minimum
 * is 1 would turn "I don't know" into "you can buy one" — which is exactly the
 * lie this whole layer exists to avoid.
 */
export function bulkTerms(economics: SupplierEconomics | null): SupplierTerms {
  if (!economics) return NO_TERMS;

  const base = {
    shippingPerUnitInCents: economics.shippingPerUnitInCents,
    leadTimeDays: economics.leadTimeDays,
    requiresCapabilities: economics.requiresCapabilities,
    provenance: economics.provenance,
    currency: economics.currency,
    freshness: economics.freshness,
    integrity: economics.integrity,
  };

  // BROKEN TIER DATA POISONS THE WHOLE RECORD, deliberately. Falling back to the
  // flat figures here would answer a question about price breaks with a number
  // from somewhere else, and it would look exactly like a good answer. If any
  // part of what a supplier said about price is unusable, none of it is quoted.
  if (!economics.integrity.ok) {
    return { ...base, minimumOrderUnits: null, bulkUnitCostInCents: null };
  }

  // An explicit UNAVAILABLE is a real answer and it is "no". Somebody looked.
  if (economics.provenance === "UNAVAILABLE") {
    return { ...base, minimumOrderUnits: null, bulkUnitCostInCents: null };
  }

  // The best real price break is the cheapest tier stated. Tiers win over flat
  // figures because a tier is what a bulk purchase would actually cost.
  const tiers = economics.tiers;
  if (tiers && tiers.length > 0) {
    const cheapest = tiers.reduce((best, tier) =>
      tier.unitCostInCents < best.unitCostInCents ? tier : best
    );
    return {
      ...base,
      minimumOrderUnits: cheapest.minUnits,
      bulkUnitCostInCents: cheapest.unitCostInCents,
    };
  }

  return {
    ...base,
    minimumOrderUnits: economics.minimumOrderUnits,
    bulkUnitCostInCents: economics.unitCostInCents,
  };
}

/**
 * Has anybody ever said anything about this product's economics?
 *
 * Deliberately true for an UNAVAILABLE record. "We asked and they refused" is
 * something somebody said, and treating it as silence would mean the day a
 * supplier finally quotes, nothing registers as having changed.
 */
export function anyTermsRecorded(terms: SupplierTerms): boolean {
  return (
    terms.provenance !== null ||
    terms.minimumOrderUnits !== null ||
    terms.bulkUnitCostInCents !== null
  );
}

// --- gaps, in the owner's words ---------------------------------------------

export type EconomicsGap = "minimum_order" | "bulk_price" | "unusable_tiers";

/** Which parts are missing, in the owner's words, and why each one matters. */
export const ECONOMICS_GAP_EXPLANATION: Record<EconomicsGap, string> = {
  minimum_order:
    "how many the supplier makes you order at once — it decides what buying in bulk would actually cost you up front",
  bulk_price:
    "what they charge per unit at that quantity — it decides whether buying in bulk is worth doing at all",
  unusable_tiers:
    "what their price breaks actually are — what's recorded doesn't add up, so I've stopped using it rather than quote you a figure I can't stand behind",
};

export function missingEconomics(economics: SupplierEconomics | null): EconomicsGap[] {
  const terms = bulkTerms(economics);
  const gaps: EconomicsGap[] = [];
  // Named FIRST, because it is not the same problem as an absence: something is
  // recorded and it is wrong, and that is the thing worth fixing.
  if (!terms.integrity.ok) gaps.push("unusable_tiers");
  if (terms.minimumOrderUnits === null) gaps.push("minimum_order");
  if (terms.bulkUnitCostInCents === null) gaps.push("bulk_price");
  return gaps;
}

/**
 * The diagnostic an operator needs, as opposed to the sentence an owner reads.
 *
 * Says which record and what is wrong with it, because "some product somewhere
 * has bad price breaks" is not something anybody can act on.
 */
export function integrityDiagnostic(storeId: string, economics: SupplierEconomics): string | null {
  if (economics.integrity.ok) return null;
  const variant = economics.externalVariantId ? `/${economics.externalVariantId}` : "";
  return (
    `Unusable supplier price breaks: ${economics.sourceKey}:${economics.externalProductId}${variant}` +
    ` (store ${storeId}, stated ${economics.statedAt.toISOString()} as ${economics.provenance})` +
    ` — ${economics.integrity.problem}.`
  );
}
