import { z } from "zod";
import type { JobHandler } from "./queue";
import { pruneTelemetry } from "@/lib/telemetry/retention";
import { pruneSignals } from "@/lib/security/retention";
import { runRetentionSweep } from "@/lib/retention/sweep";
import { notificationJobHandler } from "@/lib/orders/notificationJobs";

// WHICH HANDLER RUNS WHICH KIND.
//
// ============ A MIRRORED REGISTRY, AND TREATED AS ONE ==================
//
// ARCHITECTURE.md's standing invariant: a registry keyed by a string that
// something else produces cannot be checked by the compiler, so it needs a
// runtime cross-check. Here the two sides are JOB_KINDS — what an enqueuer may
// ask for — and HANDLERS — what a runner can actually do.
//
// The failure without one is specific and quiet: a job enqueued under a kind
// nobody handles is claimed, fails, backs off, and eventually dead-letters,
// which looks like a broken handler rather than a missing one. Worse, it looks
// like nothing at all until somebody reads the dead-letter list.
//
// scripts/verify-jobs-db.ts asserts the two sides match exactly, in both
// directions. A kind with no handler fails; a handler for a kind nobody
// declared fails too, because that is a handler nothing can ever reach.
//
// ============ WHY IT IS EMPTY TODAY ====================================
//
// The queue is the foundation, and the first users of it are the paths this
// codebase already has private fragments of — order notifications, syncs,
// webhook processing. Moving those onto it is a change to working code with
// its own risk and its own approval, so the queue lands first and proves
// itself, and each migration is its own decision.
//
// The `noop` kind is real and is not a placeholder: a queue with no registered
// kind at all cannot be exercised end to end, and an untested queue is worse
// than none. It does nothing, on purpose, and is the shape every real handler
// takes.

/**
 * Every kind an enqueuer may name.
 *
 * Adding one here without a handler below is a failing test, which is the
 * point — the alternative is discovering it from a dead-lettered job.
 */
export const JOB_KINDS = ["noop", "telemetry.prune", "security.prune", "retention.sweep", "notification.order"] as const;

export type JobKind = (typeof JOB_KINDS)[number];

/**
 * The do-nothing handler.
 *
 * Exists so the queue itself is exercisable — claim, run, complete — without
 * borrowing a real side effect to test with. It is also the reference shape:
 * a handler takes a context, does its work, and returns. It does not report
 * success; completing without throwing IS success, and throwing IS failure.
 * There is no third answer, deliberately, because a handler that could return
 * "partly done" would need the queue to decide what that means.
 */
const noop: JobHandler = async () => {};

/**
 * Age telemetry out.
 *
 * REGISTERED BUT NOT SCHEDULED. Nothing enqueues it, so it never runs — the
 * kind exists so that enabling retention is a decision about a window rather
 * than a build, and so the handler is written and tested before the day
 * somebody needs it in a hurry.
 *
 * It touches ProductEvent alone. ExecutionLog, SecuritySignal, the Growth Point
 * ledger, OutboundOperation, StorageEvent and WebhookDelivery are authoritative
 * and are never pruned by this — see lib/telemetry/retention.ts.
 */
const pruneTelemetryJob: JobHandler = async ({ job }) => {
  const payload = (job.payload ?? {}) as { retentionDays?: number; apply?: boolean };
  await pruneTelemetry({
    retentionDays: payload.retentionDays,
    // Defaults to a DRY RUN even here. A scheduled job that deletes by default
    // is one nobody reviewed before it ran.
    apply: payload.apply === true,
  });
};

/**
 * Delete security signals past their horizon.
 *
 * In the queue for the same reason telemetry pruning is: a bounded deletion
 * that can genuinely fail halfway and wants a retry with backoff. The policy —
 * which is the interesting part, and differs sharply per kind — lives in
 * lib/security/retention.ts and not here.
 *
 * Defaults to a DRY RUN, like its telemetry counterpart. A scheduled job that
 * deletes evidence by default is one nobody reviewed before it ran, and this
 * one deletes evidence.
 */
const pruneSignalsJob: JobHandler = async ({ job }) => {
  const payload = (job.payload ?? {}) as { apply?: boolean; maxPerRun?: number };
  await pruneSignals({ apply: payload.apply === true, maxPerRun: payload.maxPerRun });
};

/**
 * Apply the retention policy across the tables that grow without limit.
 *
 * Queued for the same reason the other two prunes are: a bounded deletion that
 * can fail halfway and wants a retry. Dry by default, and this one clears
 * customer data — the payloads of handled webhook deliveries.
 */
const retentionSweepJob: JobHandler = async ({ job }) => {
  const payload = (job.payload ?? {}) as { apply?: boolean; maxPerRun?: number };
  await runRetentionSweep({ apply: payload.apply === true, maxPerRun: payload.maxPerRun });
};

// ============ THE PAYLOAD BOUNDARY (2026-08-30) ====================
//
// `job.payload as NotificationPayload` was an unchecked cast across a JSON
// boundary. The enqueuer and the handler can be different deploys and nothing
// made them agree, so a renamed field would reach the handler as undefined and
// fail somewhere unrelated — or worse, not fail at all.
//
// A kind with no schema is allowed and means "this payload is not read".
// `noop` genuinely does not read one; declaring an empty object for it would
// be ceremony rather than a check.
export const JOB_SCHEMAS: Partial<Record<JobKind, z.ZodTypeAny>> = {
  "telemetry.prune": z.object({
    retentionDays: z.number().int().positive().optional(),
    apply: z.boolean().optional(),
  }),
  "retention.sweep": z.object({
    apply: z.boolean().optional(),
    maxPerRun: z.number().int().positive().max(50_000).optional(),
  }),
  "security.prune": z.object({
    apply: z.boolean().optional(),
    maxPerRun: z.number().int().positive().max(50_000).optional(),
  }),
  "notification.order": z.object({
    orderId: z.string().min(1),
    storeId: z.string().min(1),
    kind: z.enum(["confirmation", "delivery", "refund", "ownerSale"]),
  }),
};

/**
 * What drain() is handed to check a payload before a handler sees it.
 *
 * An unknown kind passes: the queue already reports and retries those
 * separately, and failing them here would report the same problem twice under
 * two different names.
 */
export function validateJobPayload(
  kind: string,
  payload: unknown,
): { ok: true } | { ok: false; error: string } {
  const schema = JOB_SCHEMAS[kind as JobKind];
  if (!schema) return { ok: true };
  const parsed = schema.safeParse(payload);
  return parsed.success
    ? { ok: true }
    : { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") };
}

export const HANDLERS: Record<string, JobHandler> = {
  noop,
  "telemetry.prune": pruneTelemetryJob,
  "security.prune": pruneSignalsJob,
  "retention.sweep": retentionSweepJob,
  // The sweep's backstop sends. The payment path still notifies inline — a
  // customer waiting for a confirmation should not wait for a queue.
  "notification.order": notificationJobHandler,
};
