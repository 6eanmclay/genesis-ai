import { prisma } from "@/lib/prisma";

// D4 — AN APPROVAL WHOSE EXECUTION STARTED AND NEVER RESOLVED (2026-08-23).
//
// The row read PENDING_APPROVAL for the whole duration of an external call, so
// two callers both passed the read and both executed: a double change to the
// live store and a double growth-point deduction. Claiming the row closes that.
//
// Claiming introduces the state this file exists for. A process that dies
// mid-execute leaves a row nobody can approve and nobody can see, and the
// question "what happened at the provider" has to be answerable or the claim is
// worse than the race it replaced.
//
// EVIDENCE, THEN TIME — the policy Sean approved, and it works because of two
// facts about the engine rather than anything invented here:
//
//   1. execute() ACCEPTS a caller-supplied executionId. The claim mints one and
//      hands it over, so the ExecutionLog row the execution writes carries that
//      exact id. Recovery asks "did THIS attempt finish", not "has it been a
//      while".
//   2. recordExecution runs BEFORE deductGrowthPoints, inside the engine's own
//      try. So an execution row proves the work completed, and its absence
//      proves the deduction never happened.
//
// Time is never the reason anything is released. It is only a guard against
// racing an execution that is still running.

/**
 * How long an attempt may be in flight before a sweep will consider it at all.
 *
 * NOT A DEADLINE AND NOT A CORRECTNESS PARAMETER. Nothing is released because
 * this elapsed — an attempt past it with a successful execution row is settled
 * as EXECUTED, not retried. It exists so a sweep running while a real execution
 * is mid-call does not touch it. Generous on purpose: image generation and
 * provider registration are slow, and being slow is not being stuck.
 */
export const ATTEMPT_GRACE_MS = 10 * 60 * 1000;

export interface RecoverySummary {
  /** Attempts whose work provably finished; settled rather than retried. */
  settled: number;
  /** Attempts with no evidence of execution; released for the owner to retry. */
  released: number;
}

/**
 * Reconcile approvals left mid-flight, using what really happened.
 *
 * Runs at the start of the read the review page already makes, so recovery
 * happens exactly when somebody is looking at the list a stuck row would
 * otherwise be missing from — no scheduler, no new entry point.
 *
 * Store-scoped like every other read here: one business's stuck work is never
 * another's to reconcile.
 */
export async function recoverStuckApprovals(storeId: string): Promise<RecoverySummary> {
  const cutoff = new Date(Date.now() - ATTEMPT_GRACE_MS);

  const inFlight = await prisma.approvalRequest.findMany({
    where: {
      storeId,
      status: "EXECUTING",
      // Old enough that it is not simply still running. See ATTEMPT_GRACE_MS —
      // this bounds what is CONSIDERED, never what is released.
      claimedAt: { lt: cutoff },
    },
    select: { id: true, attemptExecutionId: true },
  });
  if (inFlight.length === 0) return { settled: 0, released: 0 };

  const attemptIds = inFlight
    .map((row) => row.attemptExecutionId)
    .filter((id): id is string => id !== null);

  // THE EVIDENCE. One indexed read for the whole sweep.
  const logs = attemptIds.length
    ? await prisma.executionLog.findMany({
        where: { storeId, executionId: { in: attemptIds } },
        select: { executionId: true, status: true, id: true },
      })
    : [];
  const byAttempt = new Map(logs.map((log) => [log.executionId, log]));

  let settled = 0;
  let released = 0;

  for (const row of inFlight) {
    const evidence = row.attemptExecutionId ? byAttempt.get(row.attemptExecutionId) : undefined;

    if (evidence && evidence.status !== "FAILED") {
      // IT HAPPENED. The engine wrote this row before it charged, and after the
      // executable's own verification — so the work completed and the only thing
      // lost was this function's chance to say so. Releasing it here would
      // re-run a change that really landed, which is the defect D4 exists to
      // remove rather than reintroduce with a delay on it.
      //
      // If the process died between the row and the deduction, the owner is
      // under-charged. The engine already documents that as the right way to be
      // wrong, and it stays that way: nothing here charges.
      const updated = await prisma.approvalRequest.updateMany({
        where: { id: row.id, storeId, status: "EXECUTING" },
        data: {
          status: "EXECUTED",
          executionId: evidence.executionId,
          claimedAt: null,
          attemptExecutionId: null,
        },
      });
      settled += updated.count;
      continue;
    }

    // NO EVIDENCE, OR EVIDENCE OF FAILURE. Either way this attempt did not
    // complete, nothing was charged for it, and the owner may decide again.
    //
    // The one case this cannot distinguish is a process dying after the provider
    // succeeded and before the engine recorded it. No row exists, so this
    // releases and a retry repeats the provider work. Closing that needs an
    // idempotency key at each provider — deliberately out of scope, recorded in
    // D4_APPROVAL_RECOVERY.md, and narrowed to the gap between two adjacent
    // statements rather than the length of a network call.
    const updated = await prisma.approvalRequest.updateMany({
      where: { id: row.id, storeId, status: "EXECUTING" },
      data: {
        status: "PENDING_APPROVAL",
        // Kept when there is a failure to point at, so the review page can tell
        // "never acted on" from "tried and failed" — the distinction it already
        // draws from this column.
        executionId: evidence?.executionId ?? null,
        claimedAt: null,
        attemptExecutionId: null,
      },
    });
    released += updated.count;
  }

  return { settled, released };
}
