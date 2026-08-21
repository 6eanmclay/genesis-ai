import type { SourcingMethodProfile, OwnerCapability } from "./methodProfile";
import type { CapitalPosture, ProductEvidence } from "./progression";
import { spendableCents } from "./progression";
import { framingFor } from "./framing";
import type { Recommendation } from "./recommend";

// CAN this business do this, today? — and if not, what would change that.
//
// Deliberately separate from whether the product BELONGS here, which
// recommend.ts answers. They are different questions with different answers, and
// collapsing them produces the two worst failures available: recommending
// something the owner cannot afford, or silently hiding the best product in
// their catalogue because today they cannot buy it.
//
// The second failure is the quiet one, and it is why "not yet" exists as a real
// outcome rather than an absence.

export type Feasibility =
  /** Nothing is required beyond what the owner already has. */
  | { kind: "affordable" }
  /**
   * Something needed to decide is unknown.
   *
   * NOT a refusal and NOT a maybe. An unknown supplier minimum cannot become a
   * zero just because zero would let the recommendation through — that is how a
   * system starts lying about money.
   */
  | { kind: "cannot_assess"; missing: MissingFact[] }
  | {
      kind: "not_yet";
      currency: string;
      upfrontCents: number;
      shortfallCents: number;
      /**
       * WHICH capital state produced the shortfall.
       *
       * Decides whether J4 should ask, and must survive all the way to what the
       * owner reads. "You told me you have £300" and "I'm assuming you don't
       * want to spend anything" are different sentences, and saying the first to
       * somebody who never said anything is a small betrayal.
       */
      capitalBasis: "stated" | "assumed_because_unstated";
      missingCapabilities: OwnerCapability[];
      /** Null whenever any input is unknown. Never an estimate. */
      paybackWeeks: number | null;
      unitsToGo: number | null;
    };

export type MissingFact = "minimum_order" | "bulk_price" | "product_cost";

export interface FeasibilityInput {
  profile: SourcingMethodProfile;
  posture: CapitalPosture;
  supplier: { minimumOrderUnits: number | null; bulkUnitCostInCents: number | null };
  /** Null for a candidate the business has never sold. */
  evidence: ProductEvidence | null;
  currency: string;
}

/**
 * What it would cost to commit to this method, and whether the owner can.
 */
export function assessFeasibility(input: FeasibilityInput): Feasibility {
  const { profile, posture, supplier, evidence, currency } = input;

  const missingCapabilities = profile.requiresCapabilities.filter(
    (capability) => !posture.capabilities.includes(capability)
  );

  // Rung 0 — nothing is paid until a customer pays. This is the zero-capital
  // entry, and it is the ONLY branch that can return affordable without knowing
  // a single supplier number, because there is no number to know.
  if (profile.capitalModel === "none") {
    if (missingCapabilities.length === 0) return { kind: "affordable" };
    return {
      kind: "not_yet",
      currency,
      upfrontCents: 0,
      shortfallCents: 0,
      capitalBasis: posture.state === "stated" ? "stated" : "assumed_because_unstated",
      missingCapabilities,
      paybackWeeks: null,
      unitsToGo: null,
    };
  }

  // Everything above rung 0 costs money up front, and the amount is a fact about
  // the supplier. Without it there is no honest answer.
  const missing: MissingFact[] = [];
  if (supplier.minimumOrderUnits === null) missing.push("minimum_order");
  if (supplier.bulkUnitCostInCents === null) missing.push("bulk_price");
  if (missing.length > 0) return { kind: "cannot_assess", missing };

  const upfrontCents = supplier.minimumOrderUnits! * supplier.bulkUnitCostInCents!;
  const available = spendableCents(posture);
  const capitalBasis = posture.state === "stated" ? "stated" : "assumed_because_unstated";

  if (available >= upfrontCents && missingCapabilities.length === 0) {
    return { kind: "affordable" };
  }

  // PAYBACK IS NEVER ESTIMATED. It is the number somebody would spend money on,
  // so every input must be real: a margin that was actually computed from a
  // known cost, and a sales rate from actual orders.
  let paybackWeeks: number | null = null;
  let unitsToGo: number | null = null;
  if (evidence && evidence.unitsPerWeek > 0 && evidence.unitsSold > 0 && evidence.marginPerUnitCents !== null) {
    // Margin at the BULK price, not today's — the improvement IS the reason to
    // do this. Revenue per unit comes straight from what customers have actually
    // paid; the earlier version reconstructed it from margin and cancelled
    // itself out, which is the kind of arithmetic that looks fine and is not.
    const revenuePerUnitCents = Math.round(evidence.netRevenueCents / evidence.unitsSold);
    const bulkMarginPerUnit = revenuePerUnitCents - supplier.bulkUnitCostInCents!;
    if (bulkMarginPerUnit > 0) {
      paybackWeeks = Math.ceil(upfrontCents / (bulkMarginPerUnit * evidence.unitsPerWeek));
      unitsToGo = Math.max(0, Math.ceil(upfrontCents / bulkMarginPerUnit) - evidence.unitsSold);
    }
  }

  return {
    kind: "not_yet",
    currency,
    upfrontCents,
    shortfallCents: Math.max(0, upfrontCents - available),
    capitalBasis,
    missingCapabilities,
    paybackWeeks,
    unitsToGo,
  };
}

// --- combining fit and feasibility -----------------------------------------

export type Outcome =
  | { kind: "recommended_now"; reasons: string[] }
  | {
      kind: "not_yet";
      reasons: string[];
      blockers: string[];
      plan: string;
      capitalBasis: "stated" | "assumed_because_unstated";
    }
  | { kind: "not_a_fit"; concerns: string[] }
  | { kind: "cannot_assess"; missing: string[] };

const MISSING_LABEL: Record<MissingFact, string> = {
  minimum_order: "how many the supplier requires per order",
  bulk_price: "what they charge at that quantity",
  product_cost: "what this product costs you today",
};

const CAPABILITY_LABEL: Record<OwnerCapability, string> = {
  hold_stock: "somewhere to keep stock",
  provide_artwork: "artwork to put on it",
  manage_supplier: "a supplier relationship to manage",
};

function money(cents: number, currency: string): string {
  return new Intl.NumberFormat("en", { style: "currency", currency, maximumFractionDigits: 0 })
    .format(cents / 100);
}

/**
 * Fit and feasibility, combined in the order that matters.
 *
 * FIT IS EVALUATED FIRST, always. A product that does not belong in this
 * business is `not_a_fit` however affordable it is — telling an owner they can
 * afford the wrong thing is worse than saying nothing at all.
 */
export function decide(
  fit: Recommendation,
  feasibility: Feasibility,
  context: { kindLabel?: string } = {}
): Outcome {
  // 1. Does not belong. Feasibility is never consulted.
  if (fit.verdict === "does_not_fit") {
    return { kind: "not_a_fit", concerns: fit.concerns };
  }

  // 2. Nothing is known about the business, so nothing can be judged.
  if (fit.verdict === "unknown") {
    return {
      kind: "cannot_assess",
      missing: ["enough about your business to say whether this belongs in it"],
    };
  }

  // 3. Something needed to decide is unknown. An honest gap, not a refusal.
  if (feasibility.kind === "cannot_assess") {
    return { kind: "cannot_assess", missing: feasibility.missing.map((m) => MISSING_LABEL[m]) };
  }

  // 4. It fits, and cannot be done today. SHOWN, with what would change it —
  //    this is the progression made tangible, and hiding it would be the
  //    mistake this outcome exists to prevent.
  if (feasibility.kind === "not_yet") {
    const blockers: string[] = [];
    if (feasibility.shortfallCents > 0) {
      blockers.push(
        feasibility.capitalBasis === "stated"
          ? `It needs ${money(feasibility.upfrontCents, feasibility.currency)} up front, which is ${money(feasibility.shortfallCents, feasibility.currency)} more than you told me you have to put in.`
          : `It needs ${money(feasibility.upfrontCents, feasibility.currency)} up front. I'm working on the assumption you don't want to put money in — tell me if that's wrong.`
      );
    }
    for (const capability of feasibility.missingCapabilities) {
      blockers.push(`It needs ${CAPABILITY_LABEL[capability]}.`);
    }

    const plan =
      feasibility.paybackWeeks !== null && feasibility.unitsToGo !== null
        ? feasibility.unitsToGo > 0
          ? `At the rate you're selling, another ${feasibility.unitsToGo} would cover it — about ${feasibility.paybackWeeks} weeks. I'll tell you when you're there.`
          : `At the rate you're selling it would pay for itself in about ${feasibility.paybackWeeks} weeks.`
        : // No payback figure means an input was unknown. Say that rather than
          // inventing a timeline, which would be the one number an owner would
          // actually act on.
          `I can't work out how long it would take to pay for itself yet — I'd need to know what it costs you per sale.`;

    return { kind: "not_yet", reasons: fit.reasons, blockers, plan, capitalBasis: feasibility.capitalBasis };
  }

  // 5. It fits and it is affordable.
  return { kind: "recommended_now", reasons: fit.reasons };
}

/** The owner-facing name of a method, for an outcome that mentions one. */
export function methodLabel(profile: SourcingMethodProfile): string {
  return framingFor(profile.kind).label;
}
