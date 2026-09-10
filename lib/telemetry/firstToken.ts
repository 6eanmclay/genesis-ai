/**
 * WHEN DID J4 FIRST SAY ANYTHING.
 *
 * ============ WHY THIS IS A MODULE AND NOT TWO LINES ===================
 *
 * It WAS two lines, inline in app/api/chat/route.ts, and they were correct.
 * The problem was that nothing could test them: the only way to exercise
 * `if (firstTokenAtMs === null) firstTokenAtMs = Date.now() - turnStartedAt`
 * was to run a real streaming model call, which is exactly the class of
 * decision that has hidden every serious defect in this repository - the dock
 * geometry, the fake hover, the dead rows. Sean, on this specific number:
 * "don't optimize against an untrusted number", and then five things to prove
 * about it, starting with "deliberately test the instrumentation with a known
 * controlled delay".
 *
 * So the decision lives here, where a controlled delay is a three-line test,
 * and the route owns only the wiring.
 *
 * ============ NULL IS NOT ZERO =========================================
 *
 * A turn where the model never emitted text has no time-to-first-token. Zero
 * would read as "instant", and would drag down every average it entered while
 * looking like an improvement - the most dangerous possible failure for a
 * number being used to judge an optimisation. So the absence is a distinct
 * value the type carries, and `stopped()` refuses to invent one.
 *
 * ============ IT MEASURES THE TURN, NOT THE CALL =======================
 *
 * The clock starts when the request starts, not when the model call starts.
 * The owner's wait includes everything before the model was even asked - auth,
 * business resolution, context assembly - and a number that started later
 * would improve every time work moved earlier in the turn, which is precisely
 * the optimisation this exists to judge.
 */

export interface FirstTokenClock {
  /**
   * Call on every text delta. Only the first one counts; the rest are free.
   */
  markDelta(): void;
  /**
   * Milliseconds from the start of the turn to the first delta, or null if no
   * text was ever emitted. Never 0 unless the delta genuinely arrived within
   * the same millisecond the turn started.
   */
  value(): number | null;
  /** How many deltas were seen. Distinguishes "one big delta" from "streaming". */
  deltaCount(): number;
}

/**
 * @param startedAtMs when the TURN began — not when the model call began.
 * @param now injectable so a test can supply a known, controlled delay rather
 *        than sleeping, which would make the suite slow and flaky at once.
 */
export function createFirstTokenClock(startedAtMs: number, now: () => number = Date.now): FirstTokenClock {
  let firstAt: number | null = null;
  let count = 0;
  return {
    markDelta() {
      count += 1;
      if (firstAt === null) firstAt = now() - startedAtMs;
    },
    value() {
      return firstAt;
    },
    deltaCount() {
      return count;
    },
  };
}

/**
 * Whether a recorded value is a latency somebody can act on.
 *
 * Exported so the reporting side cannot quietly treat a missing measurement as
 * a fast one. A null is "we do not know", and a negative is a clock that ran
 * backwards - neither belongs in an average, and both are easy to produce by
 * accident when a start time is captured in the wrong place.
 */
export function isUsableLatency(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * The average of the turns that actually measured something.
 *
 * Returns null rather than 0 for "nothing measurable", because a dashboard
 * showing 0ms time-to-first-token would be read as the best possible result
 * when it means the opposite.
 */
export function averageLatency(values: (number | null | undefined)[]): number | null {
  const usable = values.filter(isUsableLatency);
  if (usable.length === 0) return null;
  return Math.round(usable.reduce((a, b) => a + b, 0) / usable.length);
}
