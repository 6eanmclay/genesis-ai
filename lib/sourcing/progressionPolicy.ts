// HOW GENESIS READS THE EVIDENCE — versioned, and deliberately separate from it.
//
// Evidence is what happened: units sold, over how long, at what margin, with how
// many returns. Policy is the judgement applied to it: how many units, over how
// long, is enough to justify spending real money.
//
// They change for entirely different reasons. Evidence changes when a customer
// buys something. Policy changes when we learn our thresholds were wrong. Keeping
// them apart means tuning the second never touches the first, and never rewrites
// what was recorded — a decision made last month was made under last month's
// policy, and the record says which.
//
// NOT A DATABASE TABLE. This is platform judgement, identical for every business.
// A per-business row would be a per-business fork, and the first support ticket
// about "why did MY thresholds change" would be the last good day this model has.
//
// THE NUMBERS BELOW ARE A STARTING POINT, NOT DOMAIN TRUTH. They are deliberately
// conservative: the cost of being early is an owner spending money they should
// not have, and that is a worse failure than being late.

export interface RungPolicy {
  rung: 1 | 2 | 3;
  minUnitsSold: number;
  minWindowDays: number;
  /** Above this, a product is being sent back too often to buy in bulk. */
  maxReturnRate: number;
  /**
   * Margin must be KNOWN and above this.
   *
   * An unknown margin never satisfies it. A product whose cost nobody recorded
   * cannot be shown to be profitable, and "probably fine" is not a basis for
   * telling somebody to spend money.
   */
  minNetMarginCents: number;
}

export interface ProgressionPolicy {
  /** Bumped whenever any value below changes. Recorded on every decision. */
  version: string;
  rungs: RungPolicy[];
  /**
   * How much a payback period must move before demand counts as materially
   * changed (see reconsideration).
   *
   * Expressed in WEEKS OF PAYBACK rather than as a percentage of units, and the
   * difference matters. "You have sold 50% more" is a fact about a number. "This
   * now pays for itself in four weeks instead of nine" is a fact about the
   * decision the owner actually declined. Only the second is a reason to ask
   * again.
   */
  materialPaybackChangeWeeks: number;
}

/**
 * The current policy.
 *
 * Changing a threshold is an edit here plus a version bump. Nothing that gathers
 * evidence is touched, and no stored decision changes meaning.
 */
export const CURRENT_PROGRESSION_POLICY: ProgressionPolicy = {
  version: "2026-08-20.1",
  rungs: [
    {
      // Stocked wholesale. The first rung that costs anything, so the bar is
      // about proving the product is not a fluke. Twenty units over four weeks
      // is a pattern; twenty units over three days is a spike, and buying a case
      // on a spike is exactly the mistake this exists to prevent.
      rung: 1,
      minUnitsSold: 20,
      minWindowDays: 28,
      maxReturnRate: 0.1,
      minNetMarginCents: 1,
    },
    {
      // Private label. Branded stock cannot be resold as anything else, so the
      // evidence has to be stronger than for generic stock.
      rung: 2,
      minUnitsSold: 100,
      minWindowDays: 84,
      maxReturnRate: 0.1,
      minNetMarginCents: 1,
    },
    {
      // Own production. The most to lose and the least reversible.
      rung: 3,
      minUnitsSold: 500,
      minWindowDays: 168,
      maxReturnRate: 0.1,
      minNetMarginCents: 1,
    },
  ],
  materialPaybackChangeWeeks: 1,
};

export function currentPolicy(): ProgressionPolicy {
  return CURRENT_PROGRESSION_POLICY;
}

export function rungPolicy(policy: ProgressionPolicy, rung: number): RungPolicy | null {
  return policy.rungs.find((entry) => entry.rung === rung) ?? null;
}
