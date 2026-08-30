import { createHash } from "crypto";
import { platformHealth, needsAttention } from "@/lib/admin/platformHealth";
import { checkRateLimit } from "@/lib/http/rateLimit";
import { reportIssue } from "./reportIssue";

// THE THINGS THAT GO WRONG WITHOUT THROWING.
//
// ============ WHAT WAS ACTUALLY MISSING (2026-08-30) ===================
//
// Not a destination. Sentry is wired, its DSN is set in production, reportIssue
// redacts and sends to it, and thirty-three modules call reportIssue. An earlier
// draft of the inventory said "nothing reaches a person", and that was wrong.
//
// What is missing is narrower and more specific: EXCEPTIONS reach Sentry, and
// the failures this platform actually has are not exceptions. A queue with dead
// letters, an external operation whose outcome is unknown, a scheduled task
// that stopped firing, a webhook delivery waiting to be replayed — none of
// those throw. They are conditions discovered by asking, and until now the only
// thing that asked was a page somebody had to open.
//
// needsAttention() and schedulerNeedsAttention() already compute exactly the
// right answers and had one caller each: /admin/operations. This runs them on a
// schedule and sends what they find to the destination that already exists.
//
// ============ WHY DEDUPLICATION IS THE WHOLE PROBLEM ==================
//
// These conditions PERSIST. A dead-lettered job is still dead-lettered an hour
// later, and an alerting loop that says so every hour is one somebody mutes in
// a week — at which point the platform is worse off than before, because now
// there is a channel everybody ignores.
//
// So each finding is fingerprinted by its own text and reported at most once
// per cooldown. The fingerprint deliberately includes the COUNT, so "3 jobs
// gave up" and "4 jobs gave up" are different findings: a condition getting
// worse is news, and a condition simply continuing is not.
//
// The cooldown is the rate limiter built in Item 3, reused rather than
// reinvented — an alert fired at most once per window is a rate limit, and the
// ledger, the hashing and the scheduled prune all already exist.
//
// ============ AND WHY IT SAYS NOTHING ON A HEALTHY PLATFORM ===========
//
// needsAttention is deliberately narrow and stays that way. Nothing here
// widens it, adds a threshold of its own, or reports "everything is fine" —
// a heartbeat that fires when nothing is wrong is the same noise problem
// wearing a friendlier name.

/** How long the same finding stays quiet after being reported. */
export const COOLDOWN_MS = 6 * 60 * 60 * 1000;

export interface AlertOutcome {
  /** Everything currently true and worth a person's attention. */
  findings: string[];
  /** The ones actually sent this run. The rest are inside their cooldown. */
  reported: string[];
  /** Suppressed as already-said. Counted so a quiet run is legible. */
  suppressed: number;
}

/** One finding's identity. Same text, same finding. */
function fingerprint(finding: string): string {
  return createHash("sha256").update(finding).digest("hex").slice(0, 32);
}

/**
 * Look for anything that needs a person, and say it once.
 *
 * Never throws. This runs from the scheduler, where a failure must be recorded
 * and must not take the rest of the tick down — and an alerting mechanism that
 * can crash the thing it monitors is worse than none.
 */
export interface AlertSource {
  name: string;
  read: () => Promise<string[]>;
}

/**
 * Where findings come from.
 *
 * Both, deliberately. The platform's own health, and whether the scheduler that
 * produces most of it is still running at all — a stopped scheduler is the one
 * failure that makes every other check look healthy, because nothing is
 * generating new work to be behind on.
 */
export function defaultSources(): AlertSource[] {
  return [
    // ============ ONE SOURCE, NOT TWO (2026-08-30) =================
    //
    // This had a second entry reading schedulerHealth directly, and sabotage
    // found it was redundant: dropping it changed nothing, because
    // platformHealth ALREADY carries scheduler health and needsAttention
    // already asks schedulerNeedsAttention about it — wired that way in Item 3.
    //
    // Two evaluations of one question is the mirrored-registry problem in
    // miniature. The one that drifted would have been the one nobody was
    // reading, and a duplicate that cannot be removed without a test noticing
    // is a duplicate nothing was testing.
    { name: "platformHealth", read: async () => needsAttention(await platformHealth()) },
  ];
}

export async function runAlertSweep(
  options: {
    now?: Date;
    /**
     * The sources to read. Defaults to both real ones.
     *
     * ============ A SEAM FOR ONE PROPERTY (2026-08-30) ==============
     *
     * Only so a suite can hand this a source that THROWS. "The monitor must not
     * become the outage" is the property, and it cannot be tested at all if
     * nothing can be made to fail — sabotage proved that by restructuring the
     * try/catch and changing no observable behaviour, because nothing was
     * throwing.
     *
     * Supplies input; replaces no decision. The deduplication, the dispatch and
     * the cooldown are always the real ones, and no production caller passes
     * this.
     */
    sources?: AlertSource[];
  } = {},
): Promise<AlertOutcome> {
  const findings: string[] = [];

  for (const source of options.sources ?? defaultSources()) {
    // ============ EACH SOURCE CAUGHT SEPARATELY ==================
    //
    // This runs from the scheduler. An alerting mechanism that can crash the
    // thing it monitors is worse than none — and one failing source must not
    // hide the findings of the other, which is the more likely accident.
    try {
      findings.push(...(await source.read()));
    } catch (error) {
      reportIssue(`the alert sweep could not read ${source.name}`, error, {
        subsystem: "scheduler",
        stage: `alerts.${source.name}`,
      });
    }
  }

  const reported: string[] = [];
  let suppressed = 0;

  for (const finding of findings) {
    // One per fingerprint per cooldown. checkRateLimit records the attempt
    // whether or not it allows, so a finding that keeps recurring keeps its
    // window open rather than resetting the moment it goes quiet.
    const verdict = await checkRateLimit(
      [{ kind: "alert", value: fingerprint(finding), max: 1, windowMs: COOLDOWN_MS }],
      { surface: "alerts" },
    );
    if (!verdict.allowed) {
      suppressed += 1;
      continue;
    }

    // Through reportIssue, which is the one path that redacts and reaches the
    // destination. A second dispatcher here would be a second answer to "how
    // does an operator hear about this".
    reportIssue(finding, null, {
      subsystem: "scheduler",
      stage: "alerts.needsAttention",
      extra: { finding },
    });
    reported.push(finding);
  }

  return { findings, reported, suppressed };
}
