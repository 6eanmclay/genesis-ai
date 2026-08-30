import { prismaSystem } from "@/lib/prisma";
import { SCHEDULED_TASKS, type Lane } from "./registry";
import { isDue, lastSuccesses } from "./run";

// IS THE SCHEDULER ACTUALLY RUNNING?
//
// ============ THE QUESTION NOTHING COULD ANSWER (2026-08-30) ===========
//
// A cron that never fired and a cron where every task found nothing to do
// produced identical evidence: none. There was no record that a run had
// happened, so the failure mode of the entire scheduled layer — it silently
// stops — was undetectable by design.
//
// This is the answer, and it is deliberately narrow. Three states are worth
// waking somebody for:
//
//   overdue   enabled, and later than its own interval by a wide margin.
//             Wide, because a task on a daily interval triggered daily always
//             drifts a few minutes and a monitor that cries about that is one
//             nobody reads.
//
//   stuck     a run row still `running` long after it should have finished —
//             the process died mid-task. Only visible because the row is
//             written BEFORE the work.
//
//   never     enabled and has never once succeeded. Different from overdue: a
//             task that has never run may never have been reachable at all.
//
// A task that is off is not a finding. Storage reconciliation is deliberately
// dark and saying so every hour would train somebody to ignore this.

export interface TaskHealth {
  key: string;
  lane: Lane;
  purpose: string;
  enabled: boolean;
  everyMs: number;
  lastSuccessAt: Date | null;
  lastOutcome: string | null;
  lastDurationMs: number | null;
  /** How late it is, past its interval. Null when not enabled or not late. */
  overdueByMs: number | null;
  /** A run that started and never finished. */
  stuckSince: Date | null;
}

/**
 * How overdue is overdue.
 *
 * A whole extra interval. A daily task is not "late" at 06:01 because yesterday
 * it ran at 06:00 — it is late when a day has passed and it did not run at all.
 */
const LATENESS_FACTOR = 2;

/** A `running` row older than this had its process killed. */
const STUCK_AFTER_MS = 15 * 60_000;

export async function schedulerHealth(now = new Date()): Promise<TaskHealth[]> {
  const keys = SCHEDULED_TASKS.map((t) => t.key);

  const [successes, latest, stuck] = await Promise.all([
    lastSuccesses(keys),
    // The most recent run of any outcome, so a task that is failing every tick
    // reads differently from one that has stopped being triggered at all.
    prismaSystem.scheduledTaskRun.findMany({
      where: { taskKey: { in: keys } },
      orderBy: { startedAt: "desc" },
      distinct: ["taskKey"],
      select: { taskKey: true, outcome: true, durationMs: true },
    }),
    prismaSystem.scheduledTaskRun.findMany({
      where: { outcome: "running", startedAt: { lt: new Date(now.getTime() - STUCK_AFTER_MS) } },
      orderBy: { startedAt: "asc" },
      distinct: ["taskKey"],
      select: { taskKey: true, startedAt: true },
    }),
  ]);

  const latestBy = new Map(latest.map((r) => [r.taskKey, r]));
  const stuckBy = new Map(stuck.map((r) => [r.taskKey, r.startedAt]));

  return SCHEDULED_TASKS.map((task) => {
    const enabled = task.enabled();
    const lastSuccessAt = successes.get(task.key) ?? null;
    const last = latestBy.get(task.key);

    let overdueByMs: number | null = null;
    if (enabled) {
      const threshold = task.everyMs * LATENESS_FACTOR;
      const since = lastSuccessAt ? now.getTime() - lastSuccessAt.getTime() : null;
      // A task that has never succeeded is only overdue once it has had time to.
      // Otherwise every task is "overdue" the instant this table is created,
      // which would make the very first look at this page all noise.
      if (since !== null && since > threshold) overdueByMs = since - task.everyMs;
    }

    return {
      key: task.key,
      lane: task.lane,
      purpose: task.purpose,
      enabled,
      everyMs: task.everyMs,
      lastSuccessAt,
      lastOutcome: last?.outcome ?? null,
      lastDurationMs: last?.durationMs ?? null,
      overdueByMs,
      stuckSince: stuckBy.get(task.key) ?? null,
    };
  });
}

/**
 * Which of those need a person. Same discipline as needsAttention: narrow, so a
 * non-empty answer means something.
 */
export function schedulerNeedsAttention(health: TaskHealth[]): string[] {
  const reasons: string[] = [];

  const overdue = health.filter((t) => t.overdueByMs !== null);
  if (overdue.length > 0) {
    reasons.push(`${overdue.length} scheduled task(s) overdue: ${overdue.map((t) => t.key).join(", ")}`);
  }

  const stuck = health.filter((t) => t.stuckSince);
  if (stuck.length > 0) {
    reasons.push(`${stuck.length} scheduled task(s) started and never finished: ${stuck.map((t) => t.key).join(", ")}`);
  }

  const failing = health.filter((t) => t.enabled && t.lastOutcome === "failed");
  if (failing.length > 0) {
    reasons.push(`${failing.length} scheduled task(s) failed on their last run: ${failing.map((t) => t.key).join(", ")}`);
  }

  // DELIBERATELY NOT A FINDING: a task that has never run. On a fresh deploy
  // that is every task, and an alarm that is guaranteed to fire once is an
  // alarm nobody believes the second time. `overdue` catches a task that
  // stopped; a task that never started is visible in the table above.
  return reasons;
}

/** Everything a trigger at this cadence would run right now. For the operator page. */
export async function dueNow(lanes?: Lane[], now = new Date()): Promise<string[]> {
  const tasks = SCHEDULED_TASKS.filter((t) => (lanes ? lanes.includes(t.lane) : true) && t.enabled());
  const successes = await lastSuccesses(tasks.map((t) => t.key));
  return tasks.filter((t) => isDue(t, successes.get(t.key), now)).map((t) => t.key);
}
