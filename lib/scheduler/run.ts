import { prismaSystem } from "@/lib/prisma";
import { withCorrelation, correlationId } from "@/lib/observability/correlation";
import { reportIssue } from "@/lib/observability/reportIssue";
import {
  LANE_ORDER,
  SCHEDULED_TASKS,
  type Lane,
  type ScheduledTask,
} from "./registry";

// RUN WHAT IS DUE, RECORD WHAT HAPPENED, STOP BEFORE THE FUNCTION DOES.
//
// ============ DUE-NESS COMES FROM THE DATABASE (2026-08-30) ============
//
// Not from which trigger fired. That single change is what makes this a
// scheduling layer rather than a longer route handler: a task with a daily
// interval runs once a day whether it is offered the chance once a day or once
// a minute, so the frequency of the trigger becomes an infrastructure detail
// instead of the schedule itself.
//
// The practical consequence is the requirement Sean set — when real schedules
// exist, they can be switched on without redesigning anything. A new trigger
// hitting this every two minutes changes the LATENCY of due work and changes
// no task's cadence.
//
// ============ AND FROM THE LAST SUCCESS, NOT THE LAST ATTEMPT =========
//
// A task that failed is due again immediately. That is correct for everything
// in the registry — they are recomputes and drains, where the repair for a bad
// run is another run — and it is why a failing task retries on the next tick
// without any retry machinery of its own.
//
// ============ WHAT A RUN RECORD IS, AND IS NOT =======================
//
// It is evidence. It is not a work item, not a lock, and not a queue: nothing
// reads it to decide WHAT to do, only whether enough time has passed. A
// recomputable pass must not acquire durable state, and this does not give it
// any — delete every row and the system behaves exactly as it did on its first
// deploy, which is the test of whether state is load-bearing.

export interface TaskOutcome {
  key: string;
  lane: Lane;
  /** ran | skipped | failed */
  status: "ran" | "skipped" | "failed";
  /** Why, when it did not run. */
  reason?: string;
  durationMs?: number;
}

export interface SchedulerResult {
  trigger: string;
  correlationId: string | null;
  outcomes: TaskOutcome[];
  /** Tasks that were due and could not be started inside the budget. */
  deferred: string[];
}

export interface RunOptions {
  /** Which trigger is asking. Recorded, and used for nothing else. */
  trigger: string;
  /** Only these lanes. A frequent trigger runs "queue" and nothing else. */
  lanes?: Lane[];
  /** Only this task. For an operator running one deliberately. */
  only?: string;
  /** Wall-clock ceiling for the whole invocation. */
  budgetMs?: number;
  now?: Date;
  /** Ignore the interval and run anything enabled. Never used by a trigger. */
  force?: boolean;
  /**
   * The tasks to consider. Defaults to the real registry.
   *
   * ============ WHY THIS IS A PARAMETER (2026-08-30) ================
   *
   * The cadence rules, the budget and the failure isolation are general and
   * must be proven against tasks whose behaviour a test can dictate — a runner
   * proven only against a supplier search is a runner proven against the
   * supplier's mood. Several real tasks also call third parties or send
   * notices, and a suite must not do either.
   *
   * This is NOT a seam that replaces what is under test. The runner is what is
   * under test and it is always the real one; the registry is separately
   * asserted for integrity, and both are additionally exercised together
   * through `only` on tasks that are safe to actually run. No production caller
   * passes this.
   */
  tasks?: ScheduledTask[];
}

/** How long a whole invocation may take, when a caller does not say. */
const DEFAULT_BUDGET_MS = 5 * 60_000;

/**
 * When each task last SUCCEEDED.
 *
 * One grouped query rather than one per task: this is on the read path of every
 * trigger, and a frequent trigger would otherwise open a dozen round trips to
 * discover it has nothing to do.
 */
export async function lastSuccesses(keys: string[]): Promise<Map<string, Date>> {
  const rows = await prismaSystem.scheduledTaskRun.groupBy({
    by: ["taskKey"],
    where: { taskKey: { in: keys }, outcome: "succeeded" },
    _max: { startedAt: true },
  });
  const map = new Map<string, Date>();
  for (const row of rows) {
    if (row._max.startedAt) map.set(row.taskKey, row._max.startedAt);
  }
  return map;
}

/**
 * Whether a task should run now.
 *
 * Pure, so the cadence rule is testable without a clock or a database — the
 * part most likely to be quietly wrong is exactly the part hardest to observe
 * in a system that only ticks once a day.
 */
export function isDue(
  task: Pick<ScheduledTask, "everyMs">,
  lastSuccessAt: Date | undefined,
  now: Date,
): boolean {
  // NEVER RUN IS ALWAYS DUE. It is also what makes this migration a no-op: an
  // empty table means every task is due on the first tick, which is precisely
  // what the route did before this existed.
  if (!lastSuccessAt) return true;
  return now.getTime() - lastSuccessAt.getTime() >= task.everyMs;
}

/**
 * Run every due task in the requested lanes.
 *
 * Each task gets its own correlation id, its own run record and its own catch.
 * One failing task must never take another down — that property already existed
 * as eleven hand-written try/catch blocks and is now structural.
 */
export async function runDueTasks(options: RunOptions): Promise<SchedulerResult> {
  const now = options.now ?? new Date();
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const startedAt = Date.now();
  const lanes = options.lanes ?? LANE_ORDER;

  const candidates = (options.tasks ?? SCHEDULED_TASKS)
    .filter((t) => (options.only ? t.key === options.only : lanes.includes(t.lane)))
    // COST OF DELAY FIRST. An invocation that runs out of time should lose a
    // supplier search, never a customer's receipt.
    .sort((a, b) => LANE_ORDER.indexOf(a.lane) - LANE_ORDER.indexOf(b.lane));

  const last = await lastSuccesses(candidates.map((t) => t.key));
  const outcomes: TaskOutcome[] = [];
  const deferred: string[] = [];

  for (const task of candidates) {
    if (!task.enabled()) {
      outcomes.push({ key: task.key, lane: task.lane, status: "skipped", reason: "not enabled" });
      continue;
    }
    if (!options.force && !isDue(task, last.get(task.key), now)) {
      outcomes.push({ key: task.key, lane: task.lane, status: "skipped", reason: "not due" });
      continue;
    }

    // ============ STOP BEFORE THE FUNCTION IS KILLED ==============
    //
    // The route this replaces awaited eleven things in a row with no ceiling,
    // so a slow stage did not fail — it consumed the runtime, and the stages
    // after it were never reached and never recorded. "Skipped for lack of
    // time" and "found nothing to do" were indistinguishable, which is the
    // worst possible pair to confuse in a scheduler.
    const remaining = budgetMs - (Date.now() - startedAt);
    if (remaining < task.budgetMs) {
      deferred.push(task.key);
      outcomes.push({
        key: task.key, lane: task.lane, status: "skipped",
        reason: `deferred — ${Math.max(0, remaining)}ms left, needs ${task.budgetMs}ms`,
      });
      // Deliberately CONTINUE rather than break: a cheap maintenance task after
      // an expensive one can still fit, and the sort has already put the
      // costly-to-delay work first.
      continue;
    }

    outcomes.push(await runOne(task, options.trigger));
  }

  return {
    trigger: options.trigger,
    correlationId: correlationId(),
    outcomes,
    deferred,
  };
}

/** One task, recorded from before it starts to after it ends. */
async function runOne(task: ScheduledTask, trigger: string): Promise<TaskOutcome> {
  return withCorrelation({ origin: "cron", surface: task.key }, async () => {
    const began = Date.now();

    // Written BEFORE the work, so a task that kills the process leaves a
    // `running` row rather than nothing at all. A row stuck in `running` is
    // itself the finding: it says which task was in flight when the lights
    // went out, which is unavailable if the record is only written on success.
    let runId: string | null = null;
    try {
      const row = await prismaSystem.scheduledTaskRun.create({
        data: { taskKey: task.key, outcome: "running", trigger, correlationId: correlationId() },
        select: { id: true },
      });
      runId = row.id;
    } catch (error) {
      // The bookkeeping failing must not stop the work. A task that ran and was
      // not recorded is far better than a task that did not run because its
      // record could not be written.
      reportIssue("could not record the start of a scheduled task", error, {
        subsystem: "scheduler", stage: `scheduler.record:${task.key}`,
      });
    }

    try {
      await task.run();
      const durationMs = Date.now() - began;
      await finish(runId, "succeeded", null, durationMs);
      return { key: task.key, lane: task.lane, status: "ran", durationMs };
    } catch (error) {
      const durationMs = Date.now() - began;
      const message = error instanceof Error ? error.message : String(error);
      await finish(runId, "failed", message, durationMs);
      // Same reporting the eleven hand-written catches did, in one place. On
      // Vercel a console line is short-retention runtime log; reportIssue is
      // what reaches a person.
      reportIssue(`the scheduled task ${task.key} failed`, error, {
        subsystem: "scheduler", stage: `scheduler:${task.key}`,
      });
      return { key: task.key, lane: task.lane, status: "failed", reason: message, durationMs };
    }
  });
}

async function finish(
  runId: string | null,
  outcome: "succeeded" | "failed",
  detail: string | null,
  durationMs: number,
): Promise<void> {
  if (!runId) return;
  await prismaSystem.scheduledTaskRun
    .update({
      where: { id: runId },
      data: { outcome, detail: detail?.slice(0, 1000) ?? null, finishedAt: new Date(), durationMs },
    })
    .catch((error) => {
      reportIssue("could not record the end of a scheduled task", error, {
        subsystem: "scheduler", stage: "scheduler.record",
      });
    });
}
