// HOW THE FOUR MOVES COMPARE — versioned, like the progression thresholds.
//
// Ranking is judgement, so it is policy rather than domain truth, and it is
// recorded on every decision it produces. Tuning it must never rewrite what was
// already decided.
//
// THE DECISION THAT SHAPES THIS FILE (Sean, 2026-08-20): deepening does NOT beat
// widening as a permanent rule, and widening does not beat deepening. Both are
// scored from the evidence for THIS business and THIS product, and whichever the
// evidence supports rises. A global preference would be the system deciding in
// advance what it cannot know: whether a particular owner is better served by
// improving what works or by adding beside it.
//
// So the weights below are not a ranking. They are how much each piece of
// EVIDENCE counts, and the ranking falls out of them.

export interface MovePolicy {
  version: string;

  // --- deepening: how much better would owning this be? -------------------
  /** Points per percentage point of unit-cost improvement at bulk. */
  marginImprovementWeight: number;
  /** Points for evidence strength, scaled by how far past the rung's bar it is. */
  evidenceStrengthWeight: number;
  /** Points lost per week of payback. A case that pays back in 4 weeks beats one that takes 40. */
  paybackWeekPenalty: number;

  // --- widening: how much is there to gain from another product? ----------
  /** Points per point of fit score against the business. */
  fitWeight: number;
  /**
   * Points for a catalogue that is narrow relative to what it has proven.
   *
   * A business with ONE proven product and nothing beside it has a great deal to
   * gain from a second; a business with twelve has less. This is the evidence
   * that makes widening rise on its own merits rather than by decree.
   */
  concentrationWeight: number;

  // --- shared ---------------------------------------------------------------
  /**
   * Multiplier applied to a move the owner cannot act on today.
   *
   * Below 1, so affordable beats aspirational — but never zero: a `not_yet` is
   * still shown, with its plan, because it is the most motivating thing in the
   * system.
   */
  notYetMultiplier: number;
  /**
   * How far an unblocking question must exceed the best actionable move before
   * it takes the top slot.
   *
   * Sean's rule: an Unblock leads only when resolving it would unlock a
   * materially better action. Otherwise it sits below moves the owner can
   * actually take, because a question is not an action.
   */
  unblockLeadMarginPoints: number;
  /**
   * Multiplier applied to a move whose figures carry caveats.
   *
   * Stale economics, an unknown delivery charge, an unknown lead time: none of
   * them makes a move wrong, and none of them is nothing. Between two moves the
   * owner could take today, the one resting on figures somebody confirmed this
   * month should come first — but only just, because the qualified one may still
   * be the better business decision by a wide margin.
   *
   * DELIBERATELY CLOSE TO 1. This is a tiebreaker, not a penalty. Anything
   * harsher would let a missing shipping figure bury a move worth thousands, and
   * a system that hides the best option until its paperwork is perfect is a
   * system nobody gets value from.
   */
  qualifiedConfidenceMultiplier: number;
  /** How many moves are offered. Three: enough to choose, not a catalogue. */
  moveCount: number;
}

export const CURRENT_MOVE_POLICY: MovePolicy = {
  version: "2026-08-20.1",

  // A product whose unit cost halves at bulk is a 50-point improvement before
  // anything else is counted. This is deliberately the heaviest single signal in
  // deepening: the whole reason to own something is that it costs less.
  marginImprovementWeight: 0.6,
  evidenceStrengthWeight: 12,
  paybackWeekPenalty: 1.2,

  // Fit already runs 0-30 or so for a strong match, so this keeps a well-fitting
  // new product comparable with a modest margin improvement rather than
  // dominated by it.
  fitWeight: 1.4,
  concentrationWeight: 18,

  notYetMultiplier: 0.55,
  qualifiedConfidenceMultiplier: 0.9,
  unblockLeadMarginPoints: 10,
  moveCount: 3,
};

export function currentMovePolicy(): MovePolicy {
  return CURRENT_MOVE_POLICY;
}
