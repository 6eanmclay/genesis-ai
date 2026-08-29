// WHAT A SOCIAL PIECE ASKS THE OWNER TO INVEST.
//
// ============ ONE CREATION, NOT FOUR CHARGES ===========================
//
// Sean, 2026-08-29:
//   "1 GP = one social platform
//    2 GP = multiple platforms
//    The four platforms remain one creation, not four separate charges."
//
// So the number is a property of the PIECE, not of the platforms on it, and it
// does not grow with the fourth platform any more than with the second. That is
// the whole point: choosing everywhere should feel like using Genesis properly,
// not like being metered.
//
// ============ AND THE WORDS MATTER AS MUCH AS THE NUMBER ===============
//
// Genesis already holds this rule, in the prompt every chat surface reads:
// "Whenever you refer to Growth Points being used, say 'invest'/'investment,'
// never 'spend'/'cost' — Growth Points represent an owner investing in their own
// business, not a fee for AI usage."
//
// Sean restated it for this feature — "Growth Points should be presented as the
// user's business leveling currency, not as an arbitrary technical fee" — so
// this module says invest, and no string it produces says cost, spend, fee, or
// charge.

/** The Growth Points a piece asks for, broken into what earned each one. */
export interface SocialInvestment {
  /** The whole number of Growth Points. */
  points: number;
  /** The posting half, before any amplification. */
  postingPoints: number;
  /** The Story amplification, or zero when it was not taken. */
  storyPoints: number;
  /** One line per part, for a confirmation that shows its working. */
  lines: string[];
}

/** The posting half on its own — one platform or several. */
export const SOCIAL_POST_ONE_PLATFORM = 1;
export const SOCIAL_POST_MANY_PLATFORMS = 2;
/** The optional amplification. */
export const SOCIAL_STORY_AMPLIFICATION = 1;

/**
 * What this piece asks for.
 *
 * ZERO TARGETS IS ZERO, not one. A piece with nothing selected has not asked
 * for anything, and a confirmation that said "1 Growth Point" over an empty
 * selection would be inventing a commitment.
 */
export function socialInvestment(params: {
  targetCount: number;
  /** True only when the owner took the offer AND the offer was real. */
  amplifyStory: boolean;
}): SocialInvestment {
  const { targetCount, amplifyStory } = params;

  const postingPoints =
    targetCount <= 0
      ? 0
      : targetCount === 1
        ? SOCIAL_POST_ONE_PLATFORM
        : SOCIAL_POST_MANY_PLATFORMS;

  const storyPoints = amplifyStory && targetCount > 0 ? SOCIAL_STORY_AMPLIFICATION : 0;

  const lines: string[] = [];
  if (postingPoints > 0) {
    lines.push(
      targetCount === 1
        ? `Posting to 1 platform · ${points(postingPoints)}`
        : `Posting to ${targetCount} platforms · ${points(postingPoints)}`,
    );
  }
  if (storyPoints > 0) {
    lines.push(`Story · ${points(storyPoints)}`);
  }

  return { points: postingPoints + storyPoints, postingPoints, storyPoints, lines };
}

/** "1 Growth Point" / "2 Growth Points". Singular is not a rounding error. */
export function points(n: number): string {
  return n === 1 ? "1 Growth Point" : `${n} Growth Points`;
}

/**
 * The sentence shown at commitment, before anything is invested.
 *
 * ============ THE +1 IS NAMED SEPARATELY, ALWAYS ======================
 *
 * Sean: "Make the +1 Story investment explicit before commitment." So the story
 * is never folded into a single total that leaves somebody working out what
 * changed when they ticked it — the total is shown, and so is what it is made
 * of.
 *
 * `remaining` is the balance BEFORE this, so the sentence can say what would be
 * left rather than making the owner subtract.
 */
export function investmentSummary(params: {
  investment: SocialInvestment;
  balance: number;
}): { total: string; afterwards: string; lines: string[] } {
  const { investment, balance } = params;
  return {
    total: `This will invest ${points(investment.points)}`,
    afterwards: `${points(Math.max(0, balance - investment.points))} left afterwards`,
    lines: investment.lines,
  };
}

/**
 * What the owner is told once it has actually happened.
 *
 * The mirror of growthPoints/confirmation.ts's spendSummary, which the product
 * side already uses: the accounting is shown even to somebody who asked not to
 * be interrupted by confirmations, because what their business invested is not
 * an interruption.
 *
 * NOT REACHABLE TODAY. Nothing publishes, so nothing is ever invested. It is
 * written here because the words are part of the contract, not an afterthought
 * for whoever wires the first publisher.
 */
export function investedSummary(params: {
  investment: SocialInvestment;
  remaining: number;
  platformCount: number;
}): string {
  const { investment, remaining, platformCount } = params;
  const where = platformCount === 1 ? "Posted" : `Posted to ${platformCount} platforms`;
  if (investment.points <= 0) return `${where} ✓`;
  return `${where} ✓ · ${points(investment.points)} invested · ${points(remaining)} remaining`;
}
