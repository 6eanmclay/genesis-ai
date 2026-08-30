import { randomUUID } from "crypto";
import { prismaSystem } from "@/lib/prisma";
import { reportIssue } from "@/lib/observability/reportIssue";

// WORK THAT SURVIVES THE PROCESS THAT WANTED IT DONE.
//
// ============ WHAT WAS MISSING (2026-08-30) ============================
//
// Every background thing ran inside one daily cron tick: syncs, intelligence,
// sourcing, the temporary sweep. Three consequences, all of them load-bearing
// for the Connections work that comes next:
//
//   nothing could be scheduled for "in five minutes" — only "tomorrow at 06:00"
//   nothing survived a crash half way through a batch
//   ExecutionLog.retryable was written 75 times and read by NOBODY. The system
//     recorded that an action could be retried and never retried one.
//
// A webhook handler, an outbound provider call, a notification and a sync all
// want the same four things — run later, retry with backoff, give up eventually,
// and never run twice. Each currently owns a private fragment of that, and every
// new provider would own another. This is the shared one.
//
// ============ RETRIES ARE ONLY SAFE BECAUSE OF IDEMPOTENCY =============
//
// Adding retries to a system with no idempotency turns one bug into two: the
// original failure, plus a duplicate charge or a second supplier order placed
// because the first attempt timed out AFTER succeeding.
//
// So the key is not optional and not generated for you. A caller must name the
// logical unit of work — "order-confirmation:<orderId>", not a random id — and
// the unique index turns a second enqueue into a no-op. `enqueue` returning
// `duplicate` is a normal outcome, not an error.
//
// ============ CLAIMING, AND WHY NOT `SELECT … FOR UPDATE SKIP LOCKED` ==
//
// A conditional UPDATE that only succeeds for one caller is the pattern this
// codebase already proved in lib/orders/notificationClaim.ts, and it needs no
// open transaction spanning the handler — which matters because a handler makes
// network calls, and a lock must never span one. The trade is that a killed
// runner leaves a lock behind; that is what LOCK_TTL_MS reclaims.

export type JobStatus = "pending" | "running" | "done" | "dead";

export interface JobRecord {
  id: string;
  kind: string;
  storeId: string | null;
  payload: unknown;
  idempotencyKey: string;
  attempts: number;
  maxAttempts: number;
}

/** How long a claim is honoured before another runner may take the work. */
export const LOCK_TTL_MS = 10 * 60 * 1000;

/** Base for exponential backoff between attempts. */
export const BACKOFF_BASE_MS = 30 * 1000;

/** Ceiling, so a poisoned job does not schedule itself into next year. */
export const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;

/**
 * When to try again after `attempts` failures.
 *
 * PURE, so the curve is testable without waiting for it. Exponential with a
 * ceiling: 30s, 1m, 2m, 4m … capped at six hours. No jitter yet — there is one
 * runner, so there is no thundering herd to spread out. Add it when there is.
 */
export function backoffFor(attempts: number): number {
  const exponential = BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1);
  return Math.min(exponential, MAX_BACKOFF_MS);
}

export type EnqueueOutcome =
  | { ok: true; id: string; created: true }
  /** The same logical work is already queued or already ran. Not an error. */
  | { ok: true; id: string; created: false; reason: "duplicate" };

/**
 * Offer a unit of work. Offering it twice is offering it once.
 *
 * `idempotencyKey` must describe WHAT is to be done, not when it was asked for.
 * "order-confirmation:ord_123" is right; a uuid is wrong, because two callers
 * racing to send the same confirmation must collide.
 */
export async function enqueue(input: {
  kind: string;
  idempotencyKey: string;
  storeId?: string | null;
  payload?: unknown;
  /** Earliest this may run. Defaults to now. */
  runAfter?: Date;
  maxAttempts?: number;
}): Promise<EnqueueOutcome> {
  const existing = await prismaSystem.job.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true },
  });
  if (existing) return { ok: true, id: existing.id, created: false, reason: "duplicate" };

  try {
    const row = await prismaSystem.job.create({
      data: {
        kind: input.kind,
        storeId: input.storeId ?? null,
        payload: (input.payload ?? {}) as object,
        idempotencyKey: input.idempotencyKey,
        runAfter: input.runAfter ?? new Date(),
        maxAttempts: input.maxAttempts ?? 5,
      },
      select: { id: true },
    });
    return { ok: true, id: row.id, created: true };
  } catch (error) {
    // A concurrent enqueue of the same key won the race. That is the unique
    // index doing its job, not a failure — read back and report the duplicate.
    const row = await prismaSystem.job.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      select: { id: true },
    });
    if (row) return { ok: true, id: row.id, created: false, reason: "duplicate" };
    throw error;
  }
}

/**
 * Take exclusive ownership of one due job, or return null.
 *
 * The conditional update is the lock: `status: "pending"` is in the WHERE, so
 * exactly one caller can move a row out of pending. A `count` of 0 means
 * somebody else got there first, which is an ordinary outcome and not a fault.
 *
 * ============ WHAT THE SUITE DOES AND DOES NOT PROVE ================
 *
 * verify-jobs-db asserts that two racing runners yield exactly one holder, and
 * it passes with this guard REMOVED — the pooled harness serialises the two
 * calls, so the second's candidate query already sees `running`. Same
 * limitation lib/storage/ledger.ts records about its reservation lock, and
 * recorded here for the same reason: so the next person to read this knows the
 * guard is kept because it is the right shape for a read-modify-write, not
 * because a test caught its absence.
 */
export async function claimNext(runnerId: string, now: Date = new Date()): Promise<JobRecord | null> {
  const staleBefore = new Date(now.getTime() - LOCK_TTL_MS);

  const candidates = await prismaSystem.job.findMany({
    where: {
      runAfter: { lte: now },
      OR: [
        { status: "pending" },
        // A RUNNING JOB WHOSE RUNNER DIED. Without this a crash mid-handler
        // parks the work forever, which is precisely the failure the queue
        // exists to end.
        { status: "running", lockedAt: { lt: staleBefore } },
      ],
    },
    orderBy: { runAfter: "asc" },
    take: 10,
    select: { id: true, kind: true, storeId: true, payload: true, idempotencyKey: true, attempts: true, maxAttempts: true, status: true },
  });

  for (const candidate of candidates) {
    const { count } = await prismaSystem.job.updateMany({
      // The claim. Both the status AND the staleness are re-checked here, so a
      // row that changed between the read above and this write is not stolen.
      where:
        candidate.status === "pending"
          ? { id: candidate.id, status: "pending" }
          : { id: candidate.id, status: "running", lockedAt: { lt: staleBefore } },
      data: {
        status: "running",
        lockedAt: now,
        lockedBy: runnerId,
        attempts: { increment: 1 },
      },
    });
    if (count === 1) {
      return {
        id: candidate.id,
        kind: candidate.kind,
        storeId: candidate.storeId,
        payload: candidate.payload,
        idempotencyKey: candidate.idempotencyKey,
        // The row now holds attempts + 1; report what this attempt is.
        attempts: candidate.attempts + 1,
        maxAttempts: candidate.maxAttempts,
      };
    }
  }
  return null;
}

/** The work is done. The row stays as history rather than being deleted. */
export async function complete(id: string, now: Date = new Date()): Promise<void> {
  await prismaSystem.job.updateMany({
    where: { id },
    data: { status: "done", completedAt: now, lockedAt: null, lockedBy: null, lastError: null },
  });
}

export type FailureOutcome =
  | { retrying: true; runAfter: Date }
  /** Out of attempts. Parked for a person, never silently dropped. */
  | { retrying: false; deadLettered: true };

/**
 * The attempt failed.
 *
 * Either it goes back into the queue with a longer wait, or it has exhausted
 * its attempts and is DEAD-LETTERED — kept, with its last error, and reported.
 * Nothing is ever discarded: a job nobody can see is indistinguishable from
 * work that was never asked for.
 */
export async function fail(
  job: JobRecord,
  error: unknown,
  now: Date = new Date(),
): Promise<FailureOutcome> {
  const message = error instanceof Error ? error.message : String(error);

  if (job.attempts >= job.maxAttempts) {
    await prismaSystem.job.updateMany({
      where: { id: job.id },
      data: { status: "dead", lockedAt: null, lockedBy: null, lastError: message },
    });
    reportIssue(`job ${job.kind} exhausted ${job.maxAttempts} attempts`, error, {
      subsystem: "execution",
      stage: "jobs.deadLettered",
      storeId: job.storeId ?? undefined,
    });
    return { retrying: false, deadLettered: true };
  }

  const runAfter = new Date(now.getTime() + backoffFor(job.attempts));
  await prismaSystem.job.updateMany({
    where: { id: job.id },
    data: { status: "pending", runAfter, lockedAt: null, lockedBy: null, lastError: message },
  });
  return { retrying: true, runAfter };
}

export interface JobContext {
  job: JobRecord;
  now: Date;
}

export type JobHandler = (context: JobContext) => Promise<void>;

export interface DrainResult {
  claimed: number;
  completed: number;
  retried: number;
  deadLettered: number;
  /** A kind with no registered handler. Reported, and the job is left alone. */
  unknownKinds: string[];
}

/**
 * Run due work until there is none, or until the budget runs out.
 *
 * ============ THE BUDGET IS NOT OPTIONAL ============================
 *
 * This runs inside a serverless function with a hard ceiling. A drain that
 * simply loops until the queue empties gets killed mid-handler on a busy day,
 * which is the exact crash the stale-lock reclaim above exists to recover from
 * — better not to cause it every night. `maxJobs` and `deadline` bound it, and
 * whatever is left is still due on the next tick.
 */
export async function drain(
  handlers: Record<string, JobHandler>,
  opts: { maxJobs?: number; deadline?: Date; now?: Date; runnerId?: string } = {},
): Promise<DrainResult> {
  const now = opts.now ?? new Date();
  const runnerId = opts.runnerId ?? randomUUID();
  const maxJobs = opts.maxJobs ?? 50;
  const result: DrainResult = { claimed: 0, completed: 0, retried: 0, deadLettered: 0, unknownKinds: [] };

  for (let i = 0; i < maxJobs; i++) {
    if (opts.deadline && new Date() >= opts.deadline) break;

    const job = await claimNext(runnerId, opts.now ?? new Date());
    if (!job) break;
    result.claimed++;

    const handler = handlers[job.kind];
    if (!handler) {
      // A kind nobody registered. NOT dead-lettered on the spot: the likeliest
      // cause is a deploy where the enqueuer shipped before the handler, and
      // discarding the work would lose it permanently for a reason that fixes
      // itself in minutes. It fails normally, backs off, and dead-letters only
      // if the handler never appears.
      if (!result.unknownKinds.includes(job.kind)) result.unknownKinds.push(job.kind);
      const outcome = await fail(job, new Error(`no handler registered for job kind "${job.kind}"`), now);
      if (outcome.retrying) result.retried++;
      else result.deadLettered++;
      continue;
    }

    try {
      await handler({ job, now });
      await complete(job.id, now);
      result.completed++;
    } catch (error) {
      const outcome = await fail(job, error, now);
      if (outcome.retrying) result.retried++;
      else result.deadLettered++;
    }
  }

  return result;
}

/** What is waiting, what is stuck, and what gave up. For an operator. */
export async function queueDepth(): Promise<Record<JobStatus, number>> {
  const rows = await prismaSystem.job.groupBy({ by: ["status"], _count: true });
  const depth: Record<JobStatus, number> = { pending: 0, running: 0, done: 0, dead: 0 };
  for (const row of rows) {
    if (row.status in depth) depth[row.status as JobStatus] = row._count;
  }
  return depth;
}
