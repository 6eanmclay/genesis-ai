import type { EconomicsProvenance } from "@prisma/client";

// WHEN A SUPPLIER'S TERMS STOP BEING WORTH TRUSTING — versioned, like the
// progression thresholds and the move weights, and for the same reason: this is
// judgement, not domain truth.
//
// `statedAt` existed from the first version of the economics table and nothing
// read it. That is the quiet failure mode of a timestamp: a quote somebody
// obtained in February and a quote obtained this morning were the same fact to
// the engine, and a recommendation to spend £41,000 rested equally on both.
//
// THE DECISION (2026-08-20): STALE DATA DOES NOT BLOCK. It qualifies.
//
// Blocking was the tempting rule and it is wrong. A business that recorded its
// economics five months ago would lose its recommendation entirely and be told
// "I don't know" — replacing a slightly old truth with a total absence, which is
// strictly less true. What an owner needs is the recommendation AND its age:
// "based on what you told me in February — worth checking that's still the
// price before you order."
//
// The one place staleness genuinely changes behaviour is UNAVAILABLE. "We asked
// and they wouldn't say" is a reason not to ask again next week. It is not a
// reason not to ask again ever, and the window below is what turns that record
// from a closed door back into an open question.

export interface EconomicsFreshnessPolicy {
  /** Bumped whenever any value below changes. */
  version: string;
  /**
   * How long each kind of statement stays current, in days.
   *
   * Different by provenance because the three decay for different reasons, not
   * because one is more trustworthy than another.
   */
  staleAfterDays: Record<EconomicsProvenance, number>;
}

export const CURRENT_ECONOMICS_FRESHNESS: EconomicsFreshnessPolicy = {
  version: "2026-08-20.1",
  staleAfterDays: {
    // A connector syncs on a schedule. Catalogue data a month old does not mean
    // the price is a month old — it means the sync has not run, and that is a
    // fact about Genesis worth surfacing rather than hiding behind a figure.
    SUPPLIER: 30,
    // A quote somebody obtained by asking. Roughly a quarter, which is about how
    // long a trade quote tends to be honoured, and long enough that an owner is
    // not re-interrogating their supplier every month for no reason.
    OWNER: 120,
    // "They wouldn't tell me." Worth leaving alone for a couple of months, and
    // then worth asking again — suppliers change their minds, and the owner may
    // by then be a customer worth quoting.
    UNAVAILABLE: 60,
  },
};

export function currentFreshnessPolicy(): EconomicsFreshnessPolicy {
  return CURRENT_ECONOMICS_FRESHNESS;
}

export type FreshnessState = "fresh" | "stale";

export interface Freshness {
  state: FreshnessState;
  /** Whole days since somebody stated this. */
  ageDays: number;
  /** The window this was judged against, so the caller can explain the verdict. */
  staleAfterDays: number;
  policyVersion: string;
}

/**
 * How old a statement is, judged against the window for its kind.
 *
 * `now` is an argument rather than a call to `Date.now()` inside, so a test can
 * age a record by four months without waiting four months, and so two figures
 * resolved in the same pass are judged against the same instant.
 */
export function freshnessOf(
  provenance: EconomicsProvenance,
  statedAt: Date,
  now: Date,
  policy: EconomicsFreshnessPolicy = CURRENT_ECONOMICS_FRESHNESS
): Freshness {
  const staleAfterDays = policy.staleAfterDays[provenance];
  const ageDays = Math.max(0, Math.floor((now.getTime() - statedAt.getTime()) / 86_400_000));
  return {
    state: ageDays > staleAfterDays ? "stale" : "fresh",
    ageDays,
    staleAfterDays,
    policyVersion: policy.version,
  };
}
