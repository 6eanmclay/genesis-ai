import type { SourcingMethodProfile, OwnerCapability } from "./methodProfile";
import { formatMoneyApprox } from "@/lib/money";
import { ECONOMICS_FACTS, type EconomicsFact, type SupplierTerms } from "./economics";
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

/**
 * How far the figures can be trusted, and why not further.
 *
 * NOT a probability and NOT a score. It is the set of sentences an owner would
 * want appended to a number before they act on it, and it exists because the
 * alternative — refusing to answer whenever anything is imperfect — replaces a
 * slightly qualified truth with a total absence.
 */
export interface EconomicsConfidence {
  level: "firm" | "qualified";
  /** Owner-facing, already phrased. Empty when the level is firm. */
  caveats: string[];
}

export const FIRM: EconomicsConfidence = { level: "firm", caveats: [] };

/**
 * Whether the up-front figure is the whole cost.
 *
 * `excludes_shipping` means the supplier's delivery charge is unknown, so the
 * number is a floor rather than a total. It has to travel with the number,
 * because "£410" and "at least £410" are different sentences and only one of
 * them is true.
 */
export type CostBasis = "complete" | "excludes_shipping";

export type Feasibility =
  /** Nothing is required beyond what the owner already has. */
  | { kind: "affordable"; confidence: EconomicsConfidence }
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
      costBasis: CostBasis;
      confidence: EconomicsConfidence;
    };

export type MissingFact =
  | "minimum_order"
  | "bulk_price"
  | "product_cost"
  /**
   * The supplier's figures are in a different currency from the business.
   *
   * A gap rather than a refusal, and it belongs here rather than anywhere that
   * produces a number: nothing in this codebase converts currency, and applying
   * a rate nobody supplied would turn a real quote into a fabricated one that
   * looks exactly as trustworthy.
   */
  | "matching_currency";

export interface FeasibilityInput {
  profile: SourcingMethodProfile;
  posture: CapitalPosture;
  supplier: SupplierTerms;
  /** Null for a candidate the business has never sold. */
  evidence: ProductEvidence | null;
  currency: string;
}

/**
 * What an old statement makes an owner need to hear before they spend money.
 *
 * THE DECISION (2026-08-20): STALE ECONOMICS DO NOT BLOCK. They qualify.
 * See `economicsPolicy.ts` for why blocking is the wrong rule and what each
 * window is. Here is the consequence: the recommendation still stands, and it
 * arrives carrying its own age.
 */
/** How an owner would name each fact when told its figures have aged. */
const FACT_LABEL: Record<EconomicsFact, string> = {
  minimumOrder: "the minimum order",
  unitCost: "the price",
  tiers: "the price breaks",
  shipping: "the delivery cost",
  handling: "how long they take",
};

function stalenessCaveat(supplier: SupplierTerms): string | null {
  // THE OLDEST STALE FACT SPEAKS FOR THE REST. Per-fact freshness means a
  // decision can rest on a price from this morning and a minimum from February,
  // and listing every one of them would bury the point under bookkeeping. One
  // sentence, naming the fact that has aged furthest and who stated it, is what
  // an owner would actually want to hear before spending money.
  const stale = ECONOMICS_FACTS
    .map((fact) => ({ fact, at: supplier.attribution[fact] }))
    .filter((entry) => entry.at.freshness?.state === "stale")
    .sort((a, b) => (b.at.freshness!.ageDays ?? 0) - (a.at.freshness!.ageDays ?? 0));

  const oldest = stale[0];
  if (!oldest) return null;

  const months = Math.max(1, Math.round(oldest.at.freshness!.ageDays / 30));
  const howLong = months === 1 ? "about a month ago" : `about ${months} months ago`;
  const what = FACT_LABEL[oldest.fact];
  const alsoOthers = stale.length > 1 ? ` (and ${stale.length - 1} other figure${stale.length > 2 ? "s" : ""})` : "";

  if (oldest.at.provenance === "OWNER") {
    return `You gave me ${what}${alsoOthers} ${howLong} — worth checking that's still right before you order.`;
  }
  if (oldest.at.provenance === "UNAVAILABLE") {
    return `They wouldn't tell you ${what} ${howLong}. Worth asking again.`;
  }
  return `Their catalogue last stated ${what}${alsoOthers} ${howLong} and hasn't updated since — worth confirming before you order.`;
}

/**
 * Everything true about the figures that an owner should know before acting.
 *
 * Shipping and lead time are here rather than in the `cannot_assess` gate on
 * purpose, and it is the judgement call in this file. Requiring them would send
 * every stocked recommendation back to "I don't know" — the exact paralysis the
 * economics layer was built to end — over a delivery charge that is usually a
 * fraction of the order. So they qualify the answer instead of withholding it,
 * and the wording never claims completeness it does not have.
 */
function confidenceIn(supplier: SupplierTerms, costBasis: CostBasis): EconomicsConfidence {
  const caveats: string[] = [];

  const stale = stalenessCaveat(supplier);
  if (stale) caveats.push(stale);

  if (costBasis === "excludes_shipping") {
    caveats.push(`That's before delivery — I don't know what they charge to ship them.`);
  }
  if (supplier.leadTimeDays === null) {
    caveats.push(
      `I don't know how long they take to arrive, so the timing is from when the stock lands, not when you order.`
    );
  }

  return caveats.length === 0 ? FIRM : { level: "qualified", caveats };
}

/**
 * What it would cost to commit to this method, and whether the owner can.
 */
export function assessFeasibility(input: FeasibilityInput): Feasibility {
  const { profile, posture, supplier, evidence, currency } = input;

  // CAPABILITIES COME FROM TWO PLACES AND ARE ONE QUESTION. The method demands
  // some — stocked wholesale needs somewhere to keep stock, whatever the product
  // is. The product can demand more: an item that ships on a pallet needs real
  // storage even though the method only says "hold stock". Both are facts about
  // the owner's life rather than their revenue, so both are asked and neither is
  // inferred; the union is what they would actually need.
  const required = [...profile.requiresCapabilities];
  for (const capability of supplier.requiresCapabilities) {
    if (!required.includes(capability)) required.push(capability);
  }
  const missingCapabilities = required.filter(
    (capability) => !posture.capabilities.includes(capability)
  );

  // Rung 0 — nothing is paid until a customer pays. This is the zero-capital
  // entry, and it is the ONLY branch that can return affordable without knowing
  // a single supplier number, because there is no number to know. Nothing about
  // price, shipping, lead time or staleness can qualify a figure that does not
  // exist, so the confidence here is firm by construction.
  if (profile.capitalModel === "none") {
    if (missingCapabilities.length === 0) return { kind: "affordable", confidence: FIRM };
    return {
      kind: "not_yet",
      currency,
      upfrontCents: 0,
      shortfallCents: 0,
      capitalBasis: posture.state === "stated" ? "stated" : "assumed_because_unstated",
      missingCapabilities,
      paybackWeeks: null,
      unitsToGo: null,
      costBasis: "complete",
      confidence: FIRM,
    };
  }

  // Everything above rung 0 costs money up front, and the amount is a fact about
  // the supplier. Without it there is no honest answer.
  const missing: MissingFact[] = [];
  if (supplier.minimumOrderUnits === null) missing.push("minimum_order");
  if (supplier.bulkUnitCostInCents === null) missing.push("bulk_price");

  // CURRENCY IS CHECKED, NOT ASSUMED. Comparing a supplier's figure against what
  // this business can spend only means anything if both are the same money.
  // Null is "nothing was recorded", which the two checks above already caught.
  if (supplier.currency !== null && supplier.currency !== currency) {
    missing.push("matching_currency");
  }

  if (missing.length > 0) return { kind: "cannot_assess", missing };

  const minimumUnits = supplier.minimumOrderUnits!;
  const bulkUnitCost = supplier.bulkUnitCostInCents!;

  // SHIPPING IS MONEY THAT LEAVES THE OWNER'S HANDS TO GET THE ORDER, so when
  // it is stated it is part of what the order costs and part of what each unit
  // costs. A stated 0 is an answer — "delivery included" — and is not the same
  // as null, which is nobody having said.
  const shipping = supplier.shippingPerUnitInCents;
  const costBasis: CostBasis = shipping === null ? "excludes_shipping" : "complete";
  const landedUnitCost = bulkUnitCost + (shipping ?? 0);
  const upfrontCents = minimumUnits * landedUnitCost;

  const available = spendableCents(posture);
  const capitalBasis = posture.state === "stated" ? "stated" : "assumed_because_unstated";
  const confidence = confidenceIn(supplier, costBasis);

  if (available >= upfrontCents && missingCapabilities.length === 0) {
    return { kind: "affordable", confidence };
  }

  // PAYBACK IS NEVER ESTIMATED. It is the number somebody would spend money on,
  // so every input must be real: a margin that was actually computed from a
  // known cost, and a sales rate from actual orders.
  let paybackWeeks: number | null = null;
  let unitsToGo: number | null = null;
  if (
    evidence &&
    evidence.unitsPerWeek > 0 &&
    evidence.unitsSold > 0 &&
    evidence.marginPerUnitCents !== null
  ) {
    // Margin at the BULK price, not today's — the improvement IS the reason to
    // do this. Revenue per unit comes straight from what customers have actually
    // paid; the earlier version reconstructed it from margin and cancelled
    // itself out, which is the kind of arithmetic that looks fine and is not.
    const revenuePerUnitCents = Math.round(evidence.netRevenueCents / evidence.unitsSold);
    const bulkMarginPerUnit = revenuePerUnitCents - landedUnitCost;
    if (bulkMarginPerUnit > 0) {
      const sellingWeeks = Math.ceil(upfrontCents / (bulkMarginPerUnit * evidence.unitsPerWeek));
      // LEAD TIME IS PART OF PAYBACK. The clock starts when the money leaves,
      // not when the boxes arrive, and a supplier who takes six weeks to ship is
      // six weeks of an owner's money sitting in transit earning nothing. When
      // it is unknown the figure is a floor, and `confidenceIn` says so rather
      // than the number pretending stock is instant.
      const shippingWeeks =
        supplier.leadTimeDays === null ? 0 : Math.ceil(supplier.leadTimeDays / 7);
      paybackWeeks = sellingWeeks + shippingWeeks;
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
    costBasis,
    confidence,
  };
}

// --- combining fit and feasibility -----------------------------------------

export type Outcome =
  | { kind: "recommended_now"; reasons: string[]; caveats: string[] }
  | {
      kind: "not_yet";
      reasons: string[];
      blockers: string[];
      plan: string;
      capitalBasis: "stated" | "assumed_because_unstated";
      caveats: string[];
    }
  | { kind: "not_a_fit"; concerns: string[] }
  | { kind: "cannot_assess"; missing: string[] };

const MISSING_LABEL: Record<MissingFact, string> = {
  minimum_order: "how many the supplier requires per order",
  bulk_price: "what they charge at that quantity",
  product_cost: "what this product costs you today",
  matching_currency: "what those figures come to in the currency you sell in — I won't guess at an exchange rate",
};

const CAPABILITY_LABEL: Record<OwnerCapability, string> = {
  hold_stock: "somewhere to keep stock",
  provide_artwork: "artwork to put on it",
  manage_supplier: "a supplier relationship to manage",
};

// Was Intl.NumberFormat with a currency style — already currency-correct, but
// it renders the same GBP figure as "£85" in one locale and "GB£85" in another,
// against text this platform generates server-side for no particular viewer.
// lib/money is the one place a price becomes a string.
const money = formatMoneyApprox;

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
      // "AT LEAST" WHEN THE FIGURE IS A FLOOR. An unknown delivery charge does
      // not stop the recommendation, but it must not be hidden inside a total
      // that reads like the whole cost — that is the same lie as a defaulted
      // minimum, told with a bigger number.
      const cost =
        feasibility.costBasis === "excludes_shipping"
          ? `at least ${money(feasibility.upfrontCents, feasibility.currency)}`
          : money(feasibility.upfrontCents, feasibility.currency);
      blockers.push(
        feasibility.capitalBasis === "stated"
          ? `It needs ${cost} up front, which is ${money(feasibility.shortfallCents, feasibility.currency)} more than you told me you have to put in.`
          : `It needs ${cost} up front. I'm working on the assumption you don't want to put money in — tell me if that's wrong.`
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

    return {
      kind: "not_yet",
      reasons: fit.reasons,
      blockers,
      plan,
      capitalBasis: feasibility.capitalBasis,
      caveats: feasibility.confidence.caveats,
    };
  }

  // 5. It fits and it is affordable.
  //
  // CAVEATS SURVIVE AFFORDABILITY. A recommendation to spend real money on a
  // five-month-old quote is still the right recommendation, and it is still a
  // five-month-old quote. Dropping the qualification here would mean the only
  // outcome that actually causes somebody to spend money is the one that says
  // least about where its figures came from.
  return { kind: "recommended_now", reasons: fit.reasons, caveats: feasibility.confidence.caveats };
}

/** The owner-facing name of a method, for an outcome that mentions one. */
export function methodLabel(profile: SourcingMethodProfile): string {
  return framingFor(profile.kind).label;
}
