import type { ProductSourceKind } from "@prisma/client";
import { formatMoneyApprox } from "@/lib/money";
import type { Outcome } from "./feasibility";
import type { ProductEvidence } from "./progression";
import type { Recommendation } from "./recommend";
import { framingFor } from "./framing";
import { methodProfile } from "./methodProfile";
import { rungPolicy, type ProgressionPolicy } from "./progressionPolicy";
import type { MovePolicy } from "./movePolicy";

// THE NEXT BEST BUSINESS MOVE — not the next product.
//
// Units 1-8 answer everything about one product: does it belong here, can this
// business afford it, has it earned better economics. What none of them does is
// decide WHAT TO SAY. A business does not need a catalogue; it needs to know the
// next thing worth doing, and why that rather than something else.
//
// Everything Genesis can offer is one of four moves, and they compete:
//
//   start   — sell something you never have to buy. Always available, needs
//             nothing, and is the whole answer for a business with no evidence.
//   widen   — add something beside what already sells. Needs a proven product.
//   deepen  — own the thing that is working. Better economics on something
//             already earning, and the move no catalogue can ever surface.
//   unblock — ask the one question whose answer would change the ranking.
//
// NO NEW JUDGEMENT LIVES HERE. A move wraps an Outcome the engine already
// produced, so fit and affordability are never decided twice. What this file
// adds is comparison.
//
// NO LLM. The same business on the same day must produce the same three moves,
// or "why am I being told this now" has no answer. A model narrating what
// ranking chose is the right layer, and it comes after.

export type MoveKind = "start" | "widen" | "deepen" | "unblock";

/**
 * An actionable business decision.
 *
 * Every field answers a question the owner would actually ask, in the order they
 * would ask it: what, why, on what evidence, what is in the way, what do I do,
 * and what does it get me.
 */
export interface BusinessMove {
  kind: MoveKind;
  /** What J4 recommends, in one line. */
  recommendation: string;
  /** Why — carried from the outcome, never re-derived. */
  why: string[];
  /** The facts it rests on, phrased as an owner would read them. */
  evidence: string[];
  /** What is in the way. Empty when nothing is. */
  blockers: string[];
  /** What the owner would actually do next. */
  action: string;
  /** What this unlocks — the progression consequence, not a restatement. */
  unlocks: string;
  /**
   * What the owner should know about where these figures came from.
   *
   * SEPARATE FROM `blockers`, and the distinction is load-bearing. A blocker is
   * a reason this cannot happen yet. A caveat is a reason to check something
   * before acting on a number that is otherwise sound — "these are the terms you
   * gave me five months ago". Folding the second into the first would turn every
   * ageing quote into an obstacle; leaving it out entirely is how a recommendation
   * to spend real money stops saying where its figures came from.
   */
  caveats: string[];
  score: number;
  /** The product this concerns: an owned one for deepen, a candidate otherwise. */
  productId: string | null;
  sourcedProductId: string | null;
  outcome: Outcome;
  /** Present when this is being raised again, and says why. */
  reconsideration: string | null;
}

/** Caveats from whichever outcome carries them. Never re-derived here. */
function caveatsOf(outcome: Outcome): string[] {
  return "caveats" in outcome ? outcome.caveats : [];
}

function pct(value: number): string {
  return `${Math.round(value)}%`;
}

// Was Intl.NumberFormat with a currency style — already currency-correct, but
// it renders the same GBP figure as "£85" in one locale and "GB£85" in another,
// against text this platform generates server-side for no particular viewer.
// lib/money is the one place a price becomes a string.
const money = formatMoneyApprox;

// --- evidence strength ------------------------------------------------------

/**
 * How far past the bar this product's evidence sits — 0 at the threshold, rising
 * with everything beyond it.
 *
 * Deliberately relative to policy rather than an absolute unit count: a business
 * selling 40 of something when the bar is 20 has twice the evidence, and that is
 * the comparison that matters, not the raw number.
 */
export function evidenceStrength(
  evidence: ProductEvidence,
  rung: number,
  policy: ProgressionPolicy
): number {
  const bar = rungPolicy(policy, rung);
  if (!bar || bar.minUnitsSold <= 0) return 0;
  const past = evidence.unitsSold / bar.minUnitsSold;
  // Capped: a product selling twenty times the bar is not twenty times more
  // certain, and letting one runaway product dominate every ranking forever is
  // how a partner stops noticing anything else.
  return Math.max(0, Math.min(4, past) - 1);
}

/**
 * How much cheaper each unit becomes, as a percentage — the reason to deepen.
 *
 * Null when either cost is unknown, which is what turns a deepen into an
 * unblock rather than a guess.
 */
export function marginImprovementPercent(
  evidence: ProductEvidence,
  bulkUnitCostInCents: number | null
): number | null {
  if (bulkUnitCostInCents === null || evidence.unitsSold === 0) return null;
  if (evidence.marginPerUnitCents === null) return null;
  const revenuePerUnit = evidence.netRevenueCents / evidence.unitsSold;
  const currentCost = revenuePerUnit - evidence.marginPerUnitCents;
  if (currentCost <= 0) return null;
  return ((currentCost - bulkUnitCostInCents) / currentCost) * 100;
}

/**
 * How much this business would gain from another product — 1 when it has proven
 * something and has almost nothing beside it, falling as the catalogue widens.
 *
 * This is what makes widening rise on evidence rather than by decree. A business
 * with one proven product and nothing else has an obvious complementary
 * opportunity; one with twelve products has already taken it.
 */
export function concentration(totalProducts: number, provenProducts: number): number {
  if (provenProducts === 0) return 0;
  if (totalProducts <= 1) return 1;
  return Math.max(0, Math.min(1, 1 - (totalProducts - 1) / 6));
}

// --- builders ---------------------------------------------------------------

export interface DeepenInput {
  productId: string;
  productName: string;
  fromKind: ProductSourceKind;
  toKind: ProductSourceKind;
  evidence: ProductEvidence;
  outcome: Outcome;
  bulkUnitCostInCents: number | null;
  upfrontCents: number | null;
  paybackWeeks: number | null;
  reconsideration: string | null;
  policy: ProgressionPolicy;
  movePolicy: MovePolicy;
}

export function deepenMove(input: DeepenInput): BusinessMove {
  const { evidence, movePolicy } = input;
  const improvement = marginImprovementPercent(evidence, input.bulkUnitCostInCents);
  const strength = evidenceStrength(evidence, methodProfile(input.toKind).rung, input.policy);

  // EVIDENCE DECIDES, not a preference for deepening. A product barely past the
  // bar with a small saving scores low; one selling hard with a large saving
  // scores high. Both are deepens.
  let score =
    (improvement ?? 0) * movePolicy.marginImprovementWeight +
    strength * movePolicy.evidenceStrengthWeight;
  if (input.paybackWeeks !== null) {
    score -= input.paybackWeeks * movePolicy.paybackWeekPenalty;
  }
  if (input.outcome.kind === "not_yet") score *= movePolicy.notYetMultiplier;
  const caveats = caveatsOf(input.outcome);
  if (caveats.length > 0) score *= movePolicy.qualifiedConfidenceMultiplier;
  score = Math.max(0, score);

  const framing = framingFor(input.toKind);
  const evidenceLines = [
    `${evidence.unitsSold} sold over ${evidence.windowDays} days.`,
    ...(evidence.marginPerUnitCents !== null
      ? [`${money(evidence.marginPerUnitCents, evidence.currency)} margin on each one.`]
      : []),
    ...(evidence.returnRate > 0 ? [`${pct(evidence.returnRate * 100)} come back.`] : []),
  ];

  return {
    kind: "deepen",
    recommendation: `Buy ${input.productName} properly — ${framing.label.toLowerCase()}.`,
    why: input.outcome.kind === "not_a_fit" ? [] : "reasons" in input.outcome ? input.outcome.reasons : [],
    evidence: evidenceLines,
    blockers: input.outcome.kind === "not_yet" ? input.outcome.blockers : [],
    action:
      input.upfrontCents !== null
        ? `Order ${input.productName} in bulk — about ${money(input.upfrontCents, evidence.currency)} up front.`
        : `Find out what ${input.productName} would cost in bulk.`,
    unlocks:
      improvement !== null
        ? `About ${pct(improvement)} off every unit, on something already selling.`
        : `Better margins on the product you already sell most of.`,
    caveats,
    score,
    productId: input.productId,
    sourcedProductId: null,
    outcome: input.outcome,
    reconsideration: input.reconsideration,
  };
}

export interface CandidateInput {
  sourcedProductId: string;
  name: string;
  kind: ProductSourceKind;
  fit: Recommendation;
  outcome: Outcome;
  movePolicy: MovePolicy;
  /** For widening: how narrow the catalogue is. Zero for a business with nothing proven. */
  concentration: number;
  /** Names of what already earns, for the explanation. */
  provenNames: string[];
  hasProvenProduct: boolean;
}

export function candidateMove(input: CandidateInput): BusinessMove {
  const { movePolicy, fit } = input;
  const framing = framingFor(input.kind);

  // A business with nothing proven is STARTING; one with something proven is
  // WIDENING. Same product, different move, because the business is in a
  // different place — which is the whole point of ranking by journey.
  const kind: MoveKind = input.hasProvenProduct ? "widen" : "start";

  let score = fit.score * movePolicy.fitWeight;
  if (kind === "widen") score += input.concentration * movePolicy.concentrationWeight;
  if (input.outcome.kind === "not_yet") score *= movePolicy.notYetMultiplier;
  const caveats = caveatsOf(input.outcome);
  if (caveats.length > 0) score *= movePolicy.qualifiedConfidenceMultiplier;
  score = Math.max(0, score);

  const evidence =
    kind === "widen" && input.provenNames.length > 0
      ? [`Sits beside ${input.provenNames.slice(0, 2).join(" and ")}, which already sells.`]
      : [`Costs you nothing until somebody buys it.`];

  return {
    kind,
    recommendation:
      kind === "start"
        ? `Start selling ${input.name}.`
        : `Add ${input.name} beside what's already working.`,
    why: "reasons" in input.outcome ? input.outcome.reasons : [],
    evidence,
    blockers: input.outcome.kind === "not_yet" ? input.outcome.blockers : [],
    action: `Add ${input.name} to your store — ${framing.label.toLowerCase()}.`,
    unlocks:
      kind === "start"
        ? `Your first real sales, without buying anything up front.`
        : `A second thing to sell to the customers you already have.`,
    caveats,
    score,
    productId: null,
    sourcedProductId: input.sourcedProductId,
    outcome: input.outcome,
    reconsideration: null,
  };
}

export interface UnblockInput {
  productId: string | null;
  sourcedProductId: string | null;
  subject: string;
  /** What is missing, in the owner's terms. */
  missing: string[];
  /** The question to ask. */
  question: string;
  /**
   * How strong the product behind this is.
   *
   * AN UNBLOCK IS WORTH WHAT IT WOULD UNLOCK. A missing supplier minimum on a
   * product selling hard is the most valuable thing Genesis could learn; the
   * same gap on something nobody buys is worth nothing. Scoring it from the
   * evidence is what makes Sean's rule work without a special case.
   */
  blockedMoveStrength: number;
  outcome: Outcome;
  movePolicy: MovePolicy;
}

export function unblockMove(input: UnblockInput): BusinessMove {
  return {
    kind: "unblock",
    recommendation: input.question,
    why: [`Without it I can't tell you whether ${input.subject} is worth investing in.`],
    evidence: input.missing.map((m) => `I don't know ${m}.`),
    blockers: [],
    action: input.question,
    unlocks: `Whether ${input.subject} is worth buying properly, and what that would cost.`,
    // A question has no figures, so there is nothing to qualify.
    caveats: [],
    // Deliberately the raw strength. Whether that is enough to LEAD is decided
    // by the ranker against the best actionable move, not here.
    score: input.blockedMoveStrength,
    productId: input.productId,
    sourcedProductId: input.sourcedProductId,
    outcome: input.outcome,
    reconsideration: null,
  };
}

// --- ranking ----------------------------------------------------------------

/**
 * The three moves worth showing — pure, deterministic, evidence-ordered.
 *
 * Two rules beyond the scores:
 *
 * 1. AN UNBLOCK ONLY LEADS WHEN IT UNLOCKS SOMETHING MATERIALLY BETTER. A
 *    question is not an action, so it takes the top slot only when the move it
 *    would enable beats everything the owner could do today by a real margin.
 *    Otherwise it sits below them — still offered, never suppressed.
 *
 * 2. ONE MOVE PER PRODUCT. Three suggestions about the same foam roller is a
 *    catalogue of one thing, and it is not three choices.
 */
export function rankMoves(moves: BusinessMove[], policy: MovePolicy): BusinessMove[] {
  const actionable = moves.filter((move) => move.kind !== "unblock");
  const unblocks = moves.filter((move) => move.kind === "unblock");

  const bestActionable = actionable.reduce((best, move) => Math.max(best, move.score), 0);

  const adjusted = [
    ...actionable,
    ...unblocks.map((move) => ({
      ...move,
      // Leads only if it clears the best real action by the policy margin.
      // Otherwise it is demoted below everything actionable rather than removed.
      score:
        move.score >= bestActionable + policy.unblockLeadMarginPoints
          ? move.score
          : Math.min(move.score, bestActionable) * 0.5,
    })),
  ];

  const seen = new Set<string>();
  return adjusted
    .sort((a, b) => b.score - a.score || a.kind.localeCompare(b.kind))
    .filter((move) => {
      const subject = move.productId ?? move.sourcedProductId ?? `${move.kind}:${move.recommendation}`;
      if (seen.has(subject)) return false;
      seen.add(subject);
      return true;
    })
    .slice(0, policy.moveCount);
}
