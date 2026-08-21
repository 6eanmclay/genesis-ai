import { prisma } from "@/lib/prisma";
import type { ProductSourceKind } from "@prisma/client";
import { methodProfile, methodsAboveRung, type OwnerCapability } from "./methodProfile";
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
      select: { id: true, name: true, sourceKind: true, sourceKey: true, externalProductId: true },
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

    // Supplier economics for the same external product, where discovery
    // recorded them. Unknown stays unknown, and blocks rather than defaults.
    const sourced = product.externalProductId
      ? await prisma.sourcedProduct.findFirst({
          where: { storeId, externalProductId: product.externalProductId },
          select: { minimumOrderUnits: true, bulkUnitCostInCents: true, sourceKey: true },
        })
      : null;
    const supplier = {
      minimumOrderUnits: sourced?.minimumOrderUnits ?? null,
      bulkUnitCostInCents: sourced?.bulkUnitCostInCents ?? null,
    };

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
      sourceAvailable: sourced !== null,
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
      reconsideration = materialChange(previous.conditions as unknown as ProgressionConditions, now, policy);
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
  supplier: { minimumOrderUnits: number | null; bulkUnitCostInCents: number | null },
  policy: ProgressionPolicy = currentPolicy()
): ProgressionConditions {
  return conditionsFrom({
    posture,
    supplier,
    evidence: opportunity.evidence,
    feasibility: opportunity.feasibility,
    sourceAvailable: supplier.minimumOrderUnits !== null || supplier.bulkUnitCostInCents !== null,
    policyVersion: policy.version,
  });
}
