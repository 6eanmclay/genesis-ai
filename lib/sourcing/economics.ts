import { prisma } from "@/lib/prisma";
import type { EconomicsProvenance } from "@prisma/client";
import { isOwnerCapability, type OwnerCapability } from "./methodProfile";
import { toVariantKey } from "./types";

// WHAT A SUPPLIER'S PRODUCT COSTS — the layer the progression engine was waiting
// for.
//
// Units 1-12 can reason about minimums, bulk pricing, margins and payback. In
// production none of it fires, because nothing knows what anything costs: no
// supplier API this platform can reach states bulk pricing, and the honest
// consequence has been `cannot_assess` on every deepen.
//
// This does not fix that by inventing numbers. It gives the numbers somewhere to
// live, three ways for them to arrive, and one way to say they are not available
// — and the most immediately useful of the three needs no API at all: the owner
// rings the supplier and tells Genesis what they said.

/** A price break. Cheapest tiers have the highest `minUnits`. */
export interface PriceTier {
  minUnits: number;
  unitCostInCents: number;
}

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
  unitCostInCents: number | null;
  minimumOrderUnits: number | null;
  tiers: PriceTier[] | null;
  shippingPerUnitInCents: number | null;
  leadTimeDays: number | null;
  requiresCapabilities: OwnerCapability[];
  statedAt: Date;
  note: string | null;
}

/** How this product's identity is written, and it is always all four parts. */
export interface SupplierProductRef {
  sourceKey: string;
  externalProductId: string;
  externalVariantId: string | null;
}

function parseTiers(value: unknown): PriceTier[] | null {
  if (!Array.isArray(value)) return null;
  const tiers: PriceTier[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return null;
    const raw = entry as Record<string, unknown>;
    if (typeof raw.minUnits !== "number" || !Number.isFinite(raw.minUnits)) return null;
    if (typeof raw.unitCostInCents !== "number" || !Number.isFinite(raw.unitCostInCents)) return null;
    tiers.push({ minUnits: raw.minUnits, unitCostInCents: raw.unitCostInCents });
  }
  // Ascending by quantity, so "the cheapest tier this order qualifies for" is a
  // scan rather than a sort at every call site.
  return tiers.sort((a, b) => a.minUnits - b.minUnits);
}

/**
 * What this business knows about one supplier product.
 *
 * Scoped by all four identity parts. A row for the same external id under a
 * different source is a different product and is never returned here — that
 * collision is the one this table's unique key exists to make impossible.
 */
export async function supplierEconomics(
  storeId: string,
  ref: SupplierProductRef
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

  return {
    sourceKey: row.sourceKey,
    externalProductId: row.externalProductId,
    externalVariantId: row.externalVariantId === "" ? null : row.externalVariantId,
    provenance: row.provenance,
    unitCostInCents: row.unitCostInCents,
    minimumOrderUnits: row.minimumOrderUnits,
    tiers: parseTiers(row.tiers),
    shippingPerUnitInCents: row.shippingPerUnitInCents,
    leadTimeDays: row.leadTimeDays,
    requiresCapabilities: row.requiresCapabilities.filter(isOwnerCapability),
    statedAt: row.statedAt,
    note: row.note,
  };
}

/**
 * The bulk terms a feasibility check needs, resolved from tiers or flat figures.
 *
 * Returns nulls rather than guesses. A supplier that published a unit price but
 * no minimum has told us one thing and not the other, and pretending the minimum
 * is 1 would turn "I don't know" into "you can buy one" — which is exactly the
 * lie this whole layer exists to avoid.
 */
export function bulkTerms(
  economics: SupplierEconomics | null
): { minimumOrderUnits: number | null; bulkUnitCostInCents: number | null } {
  if (!economics) return { minimumOrderUnits: null, bulkUnitCostInCents: null };

  // An explicit UNAVAILABLE is a real answer and it is "no". Somebody looked.
  if (economics.provenance === "UNAVAILABLE") {
    return { minimumOrderUnits: null, bulkUnitCostInCents: null };
  }

  // The best real price break is the cheapest tier stated. Tiers win over flat
  // figures because a tier is what a bulk purchase would actually cost.
  const tiers = economics.tiers;
  if (tiers && tiers.length > 0) {
    const cheapest = tiers.reduce((best, tier) =>
      tier.unitCostInCents < best.unitCostInCents ? tier : best
    );
    return { minimumOrderUnits: cheapest.minUnits, bulkUnitCostInCents: cheapest.unitCostInCents };
  }

  return {
    minimumOrderUnits: economics.minimumOrderUnits,
    bulkUnitCostInCents: economics.unitCostInCents,
  };
}

/** Which parts are missing, in the owner's words, and why each one matters. */
export const ECONOMICS_GAP_EXPLANATION: Record<"minimum_order" | "bulk_price", string> = {
  minimum_order:
    "how many the supplier makes you order at once — it decides what buying in bulk would actually cost you up front",
  bulk_price:
    "what they charge per unit at that quantity — it decides whether buying in bulk is worth doing at all",
};

export function missingEconomics(
  economics: SupplierEconomics | null
): ("minimum_order" | "bulk_price")[] {
  const terms = bulkTerms(economics);
  const missing: ("minimum_order" | "bulk_price")[] = [];
  if (terms.minimumOrderUnits === null) missing.push("minimum_order");
  if (terms.bulkUnitCostInCents === null) missing.push("bulk_price");
  return missing;
}

// --- writing ----------------------------------------------------------------

export interface StateEconomicsInput {
  storeId: string;
  ref: SupplierProductRef;
  provenance: EconomicsProvenance;
  unitCostInCents?: number | null;
  minimumOrderUnits?: number | null;
  tiers?: PriceTier[] | null;
  shippingPerUnitInCents?: number | null;
  leadTimeDays?: number | null;
  requiresCapabilities?: OwnerCapability[];
  statedByUserId?: string | null;
  note?: string | null;
}

/**
 * Record what somebody found out.
 *
 * The only writer, and it takes provenance as a required argument rather than
 * inferring it from the caller. A supplier's published price and a price the
 * owner was quoted are both real and are not the same fact: one can be
 * refreshed, the other has to be re-asked, and code that guesses which is which
 * would eventually refresh away something a person went and found out.
 */
export async function stateEconomics(input: StateEconomicsInput): Promise<void> {
  const variantKey = toVariantKey(input.ref.externalVariantId);
  const data = {
    provenance: input.provenance,
    unitCostInCents: input.unitCostInCents ?? null,
    minimumOrderUnits: input.minimumOrderUnits ?? null,
    tiers: input.tiers === undefined || input.tiers === null ? undefined : input.tiers,
    shippingPerUnitInCents: input.shippingPerUnitInCents ?? null,
    leadTimeDays: input.leadTimeDays ?? null,
    requiresCapabilities: input.requiresCapabilities ?? [],
    statedByUserId: input.statedByUserId ?? null,
    statedAt: new Date(),
    note: input.note ?? null,
  };

  await prisma.supplierEconomics.upsert({
    where: {
      storeId_sourceKey_externalProductId_externalVariantId: {
        storeId: input.storeId,
        sourceKey: input.ref.sourceKey,
        externalProductId: input.ref.externalProductId,
        externalVariantId: variantKey,
      },
    },
    create: {
      storeId: input.storeId,
      sourceKey: input.ref.sourceKey,
      externalProductId: input.ref.externalProductId,
      externalVariantId: variantKey,
      ...data,
    },
    update: data,
  });
}

/**
 * The owner found out and is telling Genesis.
 *
 * The path that makes the progression engine work in production TODAY, with no
 * supplier API involved: somebody rings their supplier, asks two questions, and
 * types in the answers. Recorded as OWNER so it is never silently overwritten by
 * a later catalogue sync that knows less than the person who asked.
 */
export async function ownerStatesEconomics(input: {
  storeId: string;
  ref: SupplierProductRef;
  minimumOrderUnits: number;
  bulkUnitCostInCents: number;
  userId?: string | null;
  note?: string | null;
}): Promise<void> {
  await stateEconomics({
    storeId: input.storeId,
    ref: input.ref,
    provenance: "OWNER",
    minimumOrderUnits: input.minimumOrderUnits,
    unitCostInCents: input.bulkUnitCostInCents,
    statedByUserId: input.userId ?? null,
    note: input.note ?? null,
  });
}

/**
 * Somebody looked and there is no answer to be had.
 *
 * Deliberately recordable. "Nobody has asked" and "we asked and this supplier
 * will not say" are different states, and only the first is worth putting in
 * front of an owner again next week.
 */
export async function markEconomicsUnavailable(
  storeId: string,
  ref: SupplierProductRef,
  note?: string
): Promise<void> {
  await stateEconomics({ storeId, ref, provenance: "UNAVAILABLE", note: note ?? null });
}
