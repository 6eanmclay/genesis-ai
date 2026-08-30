import { randomUUID } from "crypto";
import type { Prisma } from "@prisma/client";
import { prismaSystem } from "@/lib/prisma";
import { correlationId } from "@/lib/observability/correlation";
import { reportIssue } from "@/lib/observability/reportIssue";
import { emitAsync } from "@/lib/telemetry/emit";

// AN EXTERNAL SIDE EFFECT, PERFORMED ONCE.
//
// ============ WHY NOW (2026-08-30) ====================================
//
// The durable job queue made retries real. Before it, nothing retried anything,
// so nothing could duplicate. Now a handler that places a supplier order or
// charges a card can be run again after a timeout — and a timeout is exactly
// the case where the first attempt most likely SUCCEEDED and we simply never
// heard the answer.
//
// lib/dashboard/approvalRecovery.ts already names this gap in a comment:
// "a process dying after the provider succeeded and before the engine recorded
// it... Closing that needs an idempotency key at each provider — deliberately
// out of scope." This is that, and it is generic so a provider added next month
// inherits it rather than inventing a fourth private version. Three already
// exist: growth points, the customer notification, the owner notification.
//
// ============ THE KEY IS NOT PROOF ====================================
//
// This is the property the whole design turns on, and it is easy to get wrong.
// Claiming a key does not mean the provider did anything. The row is claimed
// BEFORE the call — it has to be, or two runners both call — so a process that
// dies mid-call leaves a claim with no answer.
//
// That state is `indeterminate`, and it is the honest one: we do not know
// whether the provider acted. It is NEVER retried automatically, because
// retrying may duplicate a charge and abandoning may lose an order, and
// choosing between those without evidence is guessing with somebody's money.
// It is resolved by ASKING THE PROVIDER — see resolveIndeterminate — or by a
// person. `externalRef` is what proof actually looks like.
//
// ============ THE FOUR STATES ARE NOT THREE ===========================
//
//   in_progress    somebody is doing it right now. Do not start a second.
//   succeeded      done, with the provider's own reference and the answer.
//   failed         the provider explicitly refused. Safe to try again.
//   indeterminate  we called, and never learned the outcome. Safe to do
//                  NEITHER without asking.
//
// Collapsing indeterminate into failed is the mistake that duplicates orders.
// Collapsing it into succeeded is the mistake that loses them.

/** How long a claim is honoured before the operation is considered indeterminate. */
export const CLAIM_TTL_MS = 5 * 60 * 1000;

export type OutboundStatus = "in_progress" | "succeeded" | "failed" | "indeterminate";

/** What a caller's own work returns. `externalRef` is the provider's id for it. */
export interface Performed<T> {
  result: T;
  /**
   * The provider's own identifier for what was created.
   *
   * STRONGLY ENCOURAGED and deliberately not required: some operations create
   * nothing addressable (a notification send). Where one exists it is the only
   * real evidence the operation happened, and it is what makes an indeterminate
   * row resolvable later.
   */
  externalRef?: string | null;
}

export type OutboundOutcome<T> =
  /** This call did the work. */
  | { status: "performed"; result: T; externalRef: string | null }
  /** It was already done; this is the answer the first call produced. */
  | { status: "replayed"; result: T; externalRef: string | null }
  /** Another runner holds a live claim. Nothing was done here. */
  | { status: "in_progress" }
  /** The provider refused. Nothing landed; trying again is safe. */
  | { status: "failed"; error: string }
  /**
   * We called and never learned the outcome. NOTHING WAS DONE HERE, and nothing
   * should be until somebody or something asks the provider.
   */
  | { status: "indeterminate"; key: string; operation: string };

export interface RunOnceInput<T> {
  /** Describes WHAT is to be done. "printful.order:ord_123", never a uuid. */
  key: string;
  /** "printful.createOrder" — groups operations and selects a reconciler. */
  operation: string;
  storeId?: string | null;
  /** The actual outbound work. Called at most once per key, ever. */
  perform: () => Promise<Performed<T>>;
  now?: Date;
  runnerId?: string;
}

/**
 * Do this exactly once, across retries, processes and restarts.
 *
 * The ordering is the whole implementation: claim, then call, then record. Any
 * other order either lets two runners call, or loses the record of a call that
 * happened.
 */
export async function runOnce<T>(input: RunOnceInput<T>): Promise<OutboundOutcome<T>> {
  const now = input.now ?? new Date();
  const runnerId = input.runnerId ?? randomUUID();
  const staleBefore = new Date(now.getTime() - CLAIM_TTL_MS);

  const existing = await prismaSystem.outboundOperation.findUnique({
    where: { idempotencyKey: input.key },
  });

  if (existing) {
    if (existing.status === "succeeded") {
      // THE REPLAY. The stored answer, not a second call — a caller retrying
      // must see what the first attempt produced, or downstream logic branches
      // on a different result than the one that actually took effect.
      // PROOF IDEMPOTENCY IS WORKING. A retry that correctly did not repeat
      // an external effect is the single most reassuring event this system can
      // emit, and it was previously invisible.
      emitAsync({
        name: "outbound.replayed", actorKind: "system", storeId: existing.storeId,
        outcome: "success", metadata: { operation: existing.operation },
        attemptKey: input.key,
      });
      return {
        status: "replayed",
        result: existing.result as T,
        externalRef: existing.externalRef,
      };
    }

    if (existing.status === "indeterminate") {
      // Never auto-retried. See the header.
      return { status: "indeterminate", key: input.key, operation: existing.operation };
    }

    if (existing.status === "in_progress") {
      if (existing.claimedAt && existing.claimedAt > staleBefore) {
        // Someone is calling the provider right now.
        return { status: "in_progress" };
      }
      // ============ THE CRASH CASE ================================
      //
      // A claim with no answer and no live runner. The provider may have acted;
      // we cannot tell from here. Recorded as indeterminate and NOT retried.
      await prismaSystem.outboundOperation.updateMany({
        where: { id: existing.id, status: "in_progress" },
        data: {
          status: "indeterminate",
          lastError: "the runner holding this claim stopped before recording an outcome",
          claimedAt: null,
          claimedBy: null,
        },
      });
      reportIssue(
        `outbound ${existing.operation} is indeterminate — the provider may or may not have acted`,
        null,
        { subsystem: "execution", stage: "outbound.indeterminate", storeId: input.storeId ?? undefined },
      );
      emitAsync({
        name: "outbound.indeterminate", actorKind: "system", storeId: input.storeId,
        outcome: "failure", metadata: { operation: existing.operation },
        attemptKey: input.key,
      });
      return { status: "indeterminate", key: input.key, operation: existing.operation };
    }

    // status === "failed": the provider refused, so nothing landed and trying
    // again is safe. Re-claim it rather than creating a second row.
    const { count } = await prismaSystem.outboundOperation.updateMany({
      where: { id: existing.id, status: "failed" },
      data: {
        status: "in_progress",
        claimedAt: now,
        claimedBy: runnerId,
        attempts: { increment: 1 },
        correlationId: correlationId(),
      },
    });
    if (count !== 1) {
      // Somebody else re-claimed between the read and the write.
      return { status: "in_progress" };
    }
    return perform(existing.id, input, now);
  }

  // First time. The unique index is what makes the create the claim: two
  // callers racing both attempt it and exactly one succeeds.
  try {
    const created = await prismaSystem.outboundOperation.create({
      data: {
        idempotencyKey: input.key,
        operation: input.operation,
        storeId: input.storeId ?? null,
        correlationId: correlationId(),
        status: "in_progress",
        attempts: 1,
        claimedAt: now,
        claimedBy: runnerId,
      },
      select: { id: true },
    });
    return perform(created.id, input, now);
  } catch {
    // The other caller won. Re-read to answer accurately rather than assuming.
    const row = await prismaSystem.outboundOperation.findUnique({
      where: { idempotencyKey: input.key },
    });
    if (row?.status === "succeeded") {
      return { status: "replayed", result: row.result as T, externalRef: row.externalRef };
    }
    return { status: "in_progress" };
  }
}

/** Call the provider, then write down what happened. */
async function perform<T>(
  id: string,
  input: RunOnceInput<T>,
  now: Date,
): Promise<OutboundOutcome<T>> {
  const startedAt = Date.now();
  try {
    const performed = await input.perform();
    await prismaSystem.outboundOperation.update({
      where: { id },
      data: {
        status: "succeeded",
        externalRef: performed.externalRef ?? null,
        // Stored so a replay returns this, not a second call's answer.
        result: (performed.result ?? null) as Prisma.InputJsonValue,
        completedAt: now,
        claimedAt: null,
        claimedBy: null,
        lastError: null,
      },
    });
    emitAsync({
      name: "outbound.performed", actorKind: "system", storeId: input.storeId,
      outcome: "success", durationMs: Date.now() - startedAt,
      metadata: { operation: input.operation, hasExternalRef: Boolean(performed.externalRef) },
      attemptKey: input.key,
    });
    return {
      status: "performed",
      result: performed.result,
      externalRef: performed.externalRef ?? null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // FAILED, NOT INDETERMINATE. The call returned — it threw, which means the
    // provider answered or the request never left. Either way nothing landed,
    // so trying again is safe. Indeterminate is reserved for the case where we
    // never got an answer at all, which is the crash path above.
    await prismaSystem.outboundOperation.update({
      where: { id },
      data: { status: "failed", lastError: message, claimedAt: null, claimedBy: null },
    });
    return { status: "failed", error: message };
  }
}

// ---------------------------------------------------------------------------
// Resolving what we could not know
// ---------------------------------------------------------------------------

/**
 * What a provider has to be able to tell us about a key it may have seen.
 *
 * This is the contract a Connections provider implements later. Genesis cannot
 * resolve an indeterminate operation on its own — only the provider knows
 * whether it acted — so the hook is defined now and every provider fills it in
 * as it is built.
 */
export type Reconciler = (
  key: string,
) => Promise<
  | { landed: true; externalRef: string; result?: unknown }
  | { landed: false }
  /** The provider cannot say either. It stays indeterminate. */
  | { landed: "unknown" }
>;

export type ResolveOutcome =
  | { resolved: "succeeded"; externalRef: string }
  | { resolved: "failed" }
  | { resolved: "still-indeterminate" }
  | { resolved: "not-indeterminate" };

/**
 * Ask the provider whether an indeterminate operation actually landed.
 *
 * THE ONLY SAFE WAY OUT of indeterminate, and it is deliberately the provider's
 * answer rather than a timeout or an assumption. A provider that cannot answer
 * leaves the row where it is, for a person — which is the correct outcome, not
 * a failure of this function.
 */
export async function resolveIndeterminate(
  key: string,
  reconcile: Reconciler,
  now: Date = new Date(),
): Promise<ResolveOutcome> {
  const row = await prismaSystem.outboundOperation.findUnique({
    where: { idempotencyKey: key },
  });
  if (!row || row.status !== "indeterminate") return { resolved: "not-indeterminate" };

  const answer = await reconcile(key);

  if (answer.landed === true) {
    await prismaSystem.outboundOperation.update({
      where: { id: row.id },
      data: {
        status: "succeeded",
        externalRef: answer.externalRef,
        result: (answer.result ?? null) as Prisma.InputJsonValue,
        completedAt: now,
        lastError: null,
      },
    });
    return { resolved: "succeeded", externalRef: answer.externalRef };
  }

  if (answer.landed === false) {
    // The provider is certain it never happened, so a retry is safe again.
    await prismaSystem.outboundOperation.update({
      where: { id: row.id },
      data: { status: "failed", lastError: "the provider confirmed this never landed" },
    });
    return { resolved: "failed" };
  }

  return { resolved: "still-indeterminate" };
}

/** Operations nobody can currently explain. For an operator, and for a person. */
export async function indeterminateOperations(limit = 100): Promise<
  { key: string; operation: string; storeId: string | null; attempts: number; createdAt: Date; lastError: string | null }[]
> {
  const rows = await prismaSystem.outboundOperation.findMany({
    where: { status: "indeterminate" },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: {
      idempotencyKey: true, operation: true, storeId: true,
      attempts: true, createdAt: true, lastError: true,
    },
  });
  return rows.map((r) => ({
    key: r.idempotencyKey,
    operation: r.operation,
    storeId: r.storeId,
    attempts: r.attempts,
    createdAt: r.createdAt,
    lastError: r.lastError,
  }));
}
