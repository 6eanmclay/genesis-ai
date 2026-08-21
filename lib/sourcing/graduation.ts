import { prisma } from "@/lib/prisma";
import type { ProductSourceKind } from "@prisma/client";
import { methodProfile, methodsAboveRung, isOwnerCapability, type OwnerCapability } from "./methodProfile";
import { reportIssue } from "@/lib/observability/reportIssue";
import { currentPolicy, type ProgressionPolicy } from "./progressionPolicy";
import {
  capitalPosture,
  earnedRungs,
  productEvidence,
  spendableCents,
  type CapitalPosture,
  type ProductEvidence,
} from "./progression";
import { assessFeasibility, type Feasibility } from "./feasibility";
import {
  anyTermsRecorded,
  bulkTerms,
  integrityDiagnostic,
  supplierEconomics,
  NO_TERMS,
  type SupplierTerms,
} from "./economics";

// When a business has EARNED a better way of sourcing something it already sells.
//
// This is the part that makes the whole thing a path rather than a catalog: a
// person starts with products they never had to buy, sells some, and Genesis
// notices when one of them has proven itself well enough to be worth owning
// properly.
//
// A graduation is always about ONE PRODUCT, never about the business. A business
// does not earn the right to buy stock; a product does, by selling.

export interface GraduationOpportunity {
  productId: string;
  productName: string;
  fromKind: ProductSourceKind;
  toKind: ProductSourceKind;
  evidence: ProductEvidence;
  feasibility: Feasibility;
  /** Present only when this is being raised AGAIN, and says why. */
  reconsideration: ReconsiderationReason | null;
}

/**
 * Everything about the world that could make a declined graduation worth
 * raising again.
 *
 * Snapshotted at the moment of a decision, and compared against later. The set
 * is deliberately wider than "the evidence" — an owner who said no to a £1,400
 * commitment has not changed their mind because units went up, but may well have
 * because the supplier dropped its minimum to 50.
 */
export interface ProgressionConditions {
  capitalState: "unstated" | "stated";
  spendableCents: number;
  ownerCapabilities: OwnerCapability[];
  minimumOrderUnits: number | null;
  bulkUnitCostInCents: number | null;
  unitsSold: number;
  unitsPerWeek: number;
  netMarginCents: number | null;
  paybackWeeks: number | null;
  sourceAvailable: boolean;
  currency: string;
  policyVersion: string;
}

/**
 * Read a stored conditions snapshot, or admit that it cannot be read.
 *
 * NOT a cast (2026-08-20). `conditions` is Json, written and read by this file
 * today — so a cast holds right up until the shape changes, at which point every
 * comparison silently reads `undefined` and "has anything changed" starts
 * answering by accident. In the core decision model that is the worst kind of
 * failure: it is invisible and it concerns money.
 *
 * Returns null on any drift. The caller treats an unreadable snapshot as a
 * decision it cannot re-evaluate, which honours the owner's decline rather than
 * re-raising something on a shape mismatch.
 */
export function parseConditions(value: unknown): ProgressionConditions | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;

  const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  const isNullableNumber = (v: unknown): v is number | null => v === null || isNumber(v);
  const isString = (v: unknown): v is string => typeof v === "string";

  if (raw.capitalState !== "unstated" && raw.capitalState !== "stated") return null;
  if (!isNumber(raw.spendableCents)) return null;
  if (!Array.isArray(raw.ownerCapabilities) || !raw.ownerCapabilities.every(isString)) return null;
  if (!isNullableNumber(raw.minimumOrderUnits)) return null;
  if (!isNullableNumber(raw.bulkUnitCostInCents)) return null;
  if (!isNumber(raw.unitsSold)) return null;
  if (!isNumber(raw.unitsPerWeek)) return null;
  if (!isNullableNumber(raw.netMarginCents)) return null;
  if (!isNullableNumber(raw.paybackWeeks)) return null;
  if (typeof raw.sourceAvailable !== "boolean") return null;
  if (!isString(raw.currency)) return null;
  if (!isString(raw.policyVersion)) return null;

  return {
    capitalState: raw.capitalState,
    spendableCents: raw.spendableCents,
    ownerCapabilities: (raw.ownerCapabilities as string[]).filter(isOwnerCapability),
    minimumOrderUnits: raw.minimumOrderUnits,
    bulkUnitCostInCents: raw.bulkUnitCostInCents,
    unitsSold: raw.unitsSold,
    unitsPerWeek: raw.unitsPerWeek,
    netMarginCents: raw.netMarginCents,
    paybackWeeks: raw.paybackWeeks,
    sourceAvailable: raw.sourceAvailable,
    currency: raw.currency,
    policyVersion: raw.policyVersion,
  };
}

export type ReconsiderationReason =
  | "capital_increased"
  | "capital_first_stated"
  | "capability_gained"
  | "minimum_order_lowered"
  | "supplier_price_dropped"
  | "margin_became_known"
  | "demand_grew"
  | "source_became_available"
  | "policy_changed";

/** What J4 says when raising something again. Never just re-raising it. */
export const RECONSIDERATION_EXPLANATION: Record<ReconsiderationReason, string> = {
  capital_increased: "You've told me you have more to invest than when I last asked.",
  capital_first_stated: "You've told me what you can invest, which you hadn't before.",
  capability_gained: "You've told me you can do something this needed.",
  minimum_order_lowered: "The supplier has lowered how many you have to order.",
  supplier_price_dropped: "The supplier has dropped its price.",
  margin_became_known: "I now know what this costs you, so I can work out whether it pays.",
  demand_grew: "It's selling fast enough now that it would pay for itself much sooner.",
  source_became_available: "The supplier can be reached again.",
  policy_changed: "I've changed how I judge when something is worth buying in bulk.",
};

/**
 * Has anything MATERIAL changed since the owner said no? — pure.
 *
 * Not a percentage, deliberately. A counter crossing an arbitrary line is not a
 * reason to ask somebody again about a decision they already made; a supplier
 * halving its minimum is.
 *
 * Returns the first reason found, in roughly the order an owner would care.
 */
export function materialChange(
  before: ProgressionConditions,
  now: ProgressionConditions,
  policy: ProgressionPolicy
): ReconsiderationReason | null {
  // The change that actually turns "no" into "yes".
  if (before.capitalState === "unstated" && now.capitalState === "stated") {
    return "capital_first_stated";
  }
  if (now.spendableCents > before.spendableCents) return "capital_increased";

  if (now.ownerCapabilities.some((c) => !before.ownerCapabilities.includes(c))) {
    return "capability_gained";
  }

  // Becoming KNOWN counts as much as improving: an unknown blocked the
  // recommendation entirely, so learning it is the change.
  if (
    now.minimumOrderUnits !== null &&
    (before.minimumOrderUnits === null || now.minimumOrderUnits < before.minimumOrderUnits)
  ) {
    return "minimum_order_lowered";
  }
  if (
    now.bulkUnitCostInCents !== null &&
    (before.bulkUnitCostInCents === null || now.bulkUnitCostInCents < before.bulkUnitCostInCents)
  ) {
    return "supplier_price_dropped";
  }
  if (now.netMarginCents !== null && before.netMarginCents === null) {
    return "margin_became_known";
  }

  if (!before.sourceAvailable && now.sourceAvailable) return "source_became_available";

  // DEMAND, EXPRESSED AS PAYBACK. "You've sold 50% more" is a fact about a
  // number; "this now pays for itself in four weeks instead of nine" is a fact
  // about the decision they declined. Only the second earns another ask.
  if (now.paybackWeeks !== null) {
    if (before.paybackWeeks === null) return "demand_grew";
    if (before.paybackWeeks - now.paybackWeeks >= policy.materialPaybackChangeWeeks) {
      return "demand_grew";
    }
  }

  if (now.policyVersion !== before.policyVersion) return "policy_changed";

  return null;
}

function conditionsFrom(input: {
  posture: CapitalPosture;
  supplier: { minimumOrderUnits: number | null; bulkUnitCostInCents: number | null };
  evidence: ProductEvidence;
  feasibility: Feasibility;
  sourceAvailable: boolean;
  policyVersion: string;
}): ProgressionConditions {
  return {
    capitalState: input.posture.state,
    spendableCents: spendableCents(input.posture),
    ownerCapabilities: input.posture.capabilities,
    minimumOrderUnits: input.supplier.minimumOrderUnits,
    bulkUnitCostInCents: input.supplier.bulkUnitCostInCents,
    unitsSold: input.evidence.unitsSold,
    unitsPerWeek: input.evidence.unitsPerWeek,
    netMarginCents: input.evidence.netMarginCents,
    paybackWeeks: input.feasibility.kind === "not_yet" ? input.feasibility.paybackWeeks : null,
    sourceAvailable: input.sourceAvailable,
    currency: input.evidence.currency,
    policyVersion: input.policyVersion,
  };
}


/**
 * The supplier listing this product came from, if any.
 *
 * Three attempts, strongest first, and each is scoped to the business:
 *
 *   1. the ADOPTION LINK, which is a fact written when the owner adopted it;
 *   2. source key + external id + variant, which identifies a listing uniquely
 *      within a source rather than across all of them;
 *   3. nothing — a product the owner typed in themselves.
 *
 * The third is not a failure. A manually entered product genuinely has no
 * supplier, and the honest consequence is `cannot_assess` rather than a
 * fabricated minimum. What it must NOT do is silently pick up another listing's
 * numbers because an external id happened to collide.
 */
async function findSupplierRow(
  storeId: string,
  product: {
    id: string;
    sourceKey: string | null;
    externalProductId: string | null;
    externalVariantId: string | null;
  }
): Promise<SupplierTerms> {
  const select = { minimumOrderUnits: true, bulkUnitCostInCents: true } as const;

  const adopted = await prisma.sourcedProduct.findFirst({
    where: { storeId, adoptedProductId: product.id },
    select: { ...select, sourceKey: true, externalProductId: true, externalVariantId: true },
  });

  // ECONOMICS COME FROM THEIR OWN RECORD FIRST (2026-08-20). SupplierEconomics
  // is where a supplier's terms live, and it is the only place an owner can put
  // what they found out by asking. The discovery row's own columns are a
  // fallback for anything written before that table existed.
  //
  // Identity is all four parts — business, source, product, variant. An external
  // id alone is not an identity: two suppliers can use the same one, and a
  // minimum of 5000 landing on a product whose real minimum is 50 is a wrong
  // number about money that nobody would catch.
  const ref = adopted
    ? {
        sourceKey: adopted.sourceKey,
        externalProductId: adopted.externalProductId,
        externalVariantId: adopted.externalVariantId === "" ? null : adopted.externalVariantId,
      }
    : product.sourceKey && product.externalProductId
      ? {
          sourceKey: product.sourceKey,
          externalProductId: product.externalProductId,
          externalVariantId: product.externalVariantId,
        }
      : null;

  if (ref) {
    const stated = await supplierEconomics(storeId, ref);
    if (stated) {
      const terms = bulkTerms(stated);

      // BROKEN PRICE DATA IS AN OPERATOR'S PROBLEM AND AN OWNER'S BLOCKER, and
      // it is neither if nobody says it out loud. The owner gets an honest "I
      // can't quote you on this"; whoever maintains the connector gets the row,
      // the store and the reason.
      const diagnostic = integrityDiagnostic(storeId, stated);
      if (diagnostic) {
        reportIssue(diagnostic, null, {
          subsystem: "sourcing",
          stage: "economics.tiers",
          storeId,
          extra: {
            productId: product.id,
            sourceKey: stated.sourceKey,
            externalProductId: stated.externalProductId,
            provenance: stated.attribution.tiers.provenance,
          },
        });
        // Returned rather than falling through. A record whose price breaks are
        // unusable does not get quietly replaced by an older figure from the
        // discovery row — that would answer the question with data we did not
        // ask for, and it would look exactly like a good answer.
        return terms;
      }

      // Even an UNAVAILABLE fact is an answer: somebody looked. It resolves to
      // nulls, which the pipeline carries as cannot_assess rather than treating
      // as never having been asked.
      if (anyTermsRecorded(terms)) return terms;
    }
  }

  // Fallbacks below carry no provenance, freshness, shipping or lead time —
  // they predate all of it, and NO_TERMS spreads the honest nulls rather than
  // letting a partial shape imply those questions were answered.
  if (adopted) {
    return {
      ...NO_TERMS,
      minimumOrderUnits: adopted.minimumOrderUnits,
      bulkUnitCostInCents: adopted.bulkUnitCostInCents,
    };
  }

  // Fallback for products adopted before the link, or created by another path.
  // Requires BOTH the source and the external id, for the reason above.
  if (product.sourceKey && product.externalProductId) {
    const row = await prisma.sourcedProduct.findFirst({
      where: {
        storeId,
        sourceKey: product.sourceKey,
        externalProductId: product.externalProductId,
        // "" is the no-variant sentinel; a product with no variant must match
        // the listing with no variant, not the first variant of it.
        externalVariantId: product.externalVariantId ?? "",
      },
      select,
    });
    if (row) {
      return {
        ...NO_TERMS,
        minimumOrderUnits: row.minimumOrderUnits,
        bulkUnitCostInCents: row.bulkUnitCostInCents,
      };
    }
  }

  return NO_TERMS;
}

/**
 * What this business has earned the right to do differently.
 *
 * A graduation that is `not_yet` is STILL RETURNED. It is the most motivating
 * thing in the system — "you're 40 units away from halving what this costs you"
 * — and hiding it until it is affordable would remove the only reason to keep
 * going.
 */
export async function findGraduationOpportunities(
  storeId: string,
  options: { policy?: ProgressionPolicy } = {}
): Promise<GraduationOpportunity[]> {
  const policy = options.policy ?? currentPolicy();
  const [products, posture, decisions] = await Promise.all([
    prisma.product.findMany({
      where: { storeId, active: true },
      select: { id: true, name: true, sourceKind: true, sourceKey: true, externalProductId: true, externalVariantId: true },
    }),
    capitalPosture(storeId),
    prisma.progressionDecision.findMany({ where: { storeId } }),
  ]);

  const opportunities: GraduationOpportunity[] = [];

  for (const product of products) {
    const evidence = await productEvidence(storeId, product.id);
    const earned = earnedRungs(evidence, policy);
    if (earned.length === 0) continue;

    const fromRung = methodProfile(product.sourceKind).rung;
    // The highest rung this product has earned that is genuinely a step up.
    const target = methodsAboveRung(fromRung)
      .filter((profile) => earned.includes(profile.rung))
      .pop();
    if (!target) continue;

    // WHICH SUPPLIER ROW BELONGS TO THIS PRODUCT (hardened 2026-08-20).
    //
    // The adoption link is the FACT: `SourcedProduct.adoptedProductId` was
    // written when the owner adopted the candidate, and it says exactly which
    // supplier listing became this product. The earlier version matched on
    // `externalProductId` alone, which is a heuristic wearing a fact's clothes:
    // it is not unique across sources, so two suppliers listing the same
    // external id could have handed this product the wrong one's minimum — a
    // wrong number about money, silently.
    //
    // The id match survives as a fallback for products adopted before the link
    // existed, and it is scoped by sourceKey as well, which the original was not.
    // The WHOLE terms, not two of the columns. Shipping, lead time and the
    // capabilities this particular product demands were being dropped here for
    // the first fortnight of the table's life: stored, read out of the database,
    // and then discarded one line before the only function that could use them.
    const supplier = await findSupplierRow(storeId, product);

    const feasibility = assessFeasibility({
      profile: target,
      posture,
      supplier,
      evidence,
      currency: evidence.currency,
    });

    const now = conditionsFrom({
      posture,
      supplier,
      evidence,
      feasibility,
      sourceAvailable: anyTermsRecorded(supplier),
      policyVersion: policy.version,
    });

    // Already answered? Only raise it again if something material moved.
    const previous = decisions
      .filter((d) => d.productId === product.id && d.toKind === target.kind)
      .sort((a, b) => b.decidedAt.getTime() - a.decidedAt.getTime())[0];

    let reconsideration: ReconsiderationReason | null = null;
    if (previous) {
      // Accepted means it is done. Nothing to offer.
      if (previous.decision === "ACCEPTED") continue;

      const before = parseConditions(previous.conditions);
      if (!before) {
        // The snapshot cannot be read, so nothing can be compared. The owner
        // declined this; honouring that is the conservative half of the choice,
        // and re-raising on a shape mismatch would be nagging somebody because
        // OUR schema moved.
        //
        // Reported rather than swallowed: a snapshot that will not parse is a
        // real drift somebody needs to see, and silence here would hide the one
        // failure this validation exists to catch.
        reportIssue(`a progression decision's conditions could not be read`, null, {
          subsystem: "sourcing",
          stage: "progression.conditions",
          storeId,
          extra: { productId: product.id, decisionId: previous.id, policyVersion: previous.policyVersion },
        });
        continue;
      }

      reconsideration = materialChange(before, now, policy);
      // Declined, and nothing has changed. Not raised again, however much time
      // has passed — time is not a reason, and re-asking on a timer is how a
      // partner becomes a nag.
      if (!reconsideration) continue;
    }

    opportunities.push({
      productId: product.id,
      productName: product.name,
      fromKind: product.sourceKind,
      toKind: target.kind,
      evidence,
      feasibility,
      reconsideration,
    });
  }

  return opportunities;
}

/**
 * Record the owner's answer, with the conditions that produced the offer.
 *
 * The snapshot is the point: without it, "has anything changed" has nothing to
 * compare against and reconsideration degenerates into a timer.
 */
export async function recordProgressionDecision(params: {
  storeId: string;
  productId: string;
  toKind: ProductSourceKind;
  decision: "ACCEPTED" | "DECLINED";
  conditions: ProgressionConditions;
  policyVersion?: string;
}): Promise<void> {
  await prisma.progressionDecision.create({
    data: {
      storeId: params.storeId,
      productId: params.productId,
      toKind: params.toKind,
      decision: params.decision,
      policyVersion: params.policyVersion ?? params.conditions.policyVersion,
      conditions: { ...params.conditions },
    },
  });
}

/** The conditions behind an opportunity, for recording a decision about it. */
export function conditionsOf(
  opportunity: GraduationOpportunity,
  posture: CapitalPosture,
  supplier: SupplierTerms,
  policy: ProgressionPolicy = currentPolicy()
): ProgressionConditions {
  return conditionsFrom({
    posture,
    supplier,
    evidence: opportunity.evidence,
    feasibility: opportunity.feasibility,
    // The SAME test the live path uses. These two disagreed before — one asked
    // whether a row existed, the other whether it held figures — so an
    // UNAVAILABLE record counted as "no source" when a decision was recorded and
    // as "source present" when it was reconsidered, and the day a supplier
    // finally quoted, nothing registered as having changed.
    sourceAvailable: anyTermsRecorded(supplier),
    policyVersion: policy.version,
  });
}
