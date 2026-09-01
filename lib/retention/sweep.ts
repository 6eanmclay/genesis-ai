import { prismaSystem } from "@/lib/prisma";
import { RETENTION, daysAgo, type RetentionPolicy } from "./policy";

// APPLYING THE POLICY.
//
// ============ THE SAME DISCIPLINE THE SIGNAL PRUNE USES ================
//
// Bounded, idempotent, and honest about stopping. At most MAX_PER_RUN rows per
// table per run, so a first pass over years of backlog is a series of ordinary
// statements rather than one that locks a table. Selection is by age and by
// state, so running it twice does nothing the second time. And it reports when
// it hit the cap, because a backlog that never shrinks and a table with nothing
// to do look identical in a count of zero.
//
// ============ AND IT DEFAULTS TO A DRY RUN ============================
//
// Every destructive path in this codebase does. A scheduled job that deletes by
// default is one nobody reviewed before it ran, and this one deletes customer
// data.

export const MAX_PER_RUN = 5_000;

export interface TableResult {
  model: string;
  verdict: RetentionPolicy["verdict"];
  /** Rows deleted, or rows whose payload was cleared. */
  affected: number;
  /** What would have happened, on a dry run. */
  wouldAffect: number;
  /** True when the cap was reached and more remains. */
  moreRemaining: boolean;
  /** Present when the verdict is `decide` — nothing was touched, and why. */
  skipped?: string;
}

export interface SweepResult {
  tables: TableResult[];
  applied: boolean;
}

export async function runRetentionSweep(
  options: { now?: Date; apply?: boolean; maxPerRun?: number } = {},
): Promise<SweepResult> {
  const now = options.now ?? new Date();
  const apply = options.apply ?? false;
  const cap = options.maxPerRun ?? MAX_PER_RUN;
  const tables: TableResult[] = [];

  for (const policy of RETENTION) {
    if (policy.verdict === "decide") {
      // Deliberately untouched. Reported so the sweep's own output names what
      // it is refusing to do rather than silently covering fewer tables than
      // the policy lists.
      tables.push({
        model: policy.model, verdict: "decide", affected: 0, wouldAffect: 0,
        moreRemaining: false, skipped: policy.needs ?? "awaiting a decision",
      });
      continue;
    }

    const cutoff = daysAgo(policy.keepDays!, now);
    tables.push(
      policy.verdict === "redact"
        ? await redactDeliveries(cutoff, cap, apply)
        : await pruneTable(policy, cutoff, cap, apply),
    );
  }

  return { tables, applied: apply };
}

/**
 * Clear payloads on deliveries old enough that replay is no longer meaningful.
 *
 * ============ A FAILED DELIVERY KEEPS ITS BODY ====================
 *
 * Whatever its age. The bytes are what a replay runs on, and redacting one
 * would turn a recoverable failure into a permanent one — quietly, months
 * later, in the one place somebody would go looking for a lost order.
 */
async function redactDeliveries(cutoff: Date, cap: number, apply: boolean): Promise<TableResult> {
  const where = {
    receivedAt: { lt: cutoff },
    // Only deliveries that are finished with. `failed` is excluded because it
    // may still be replayed; `replaying` because it is being replayed now.
    status: { in: ["processed", "rejected"] },
    // Already-redacted rows are empty, so this never picks the same row twice —
    // which is what makes the sweep idempotent without a cursor.
    payload: { not: "" },
  };

  const due = await prismaSystem.webhookDelivery.findMany({
    where, select: { id: true }, take: cap, orderBy: { receivedAt: "asc" },
  });

  if (!apply) {
    return {
      model: "webhookDelivery", verdict: "redact", affected: 0,
      wouldAffect: due.length, moreRemaining: due.length >= cap,
    };
  }

  const result = await prismaSystem.webhookDelivery.updateMany({
    where: { id: { in: due.map((d) => d.id) } },
    // Emptied rather than nulled: the column is not nullable, and an empty
    // string is an honest "we no longer hold this" that the `not: ""` filter
    // above can recognise.
    data: { payload: "" },
  });

  return {
    model: "webhookDelivery", verdict: "redact", affected: result.count,
    wouldAffect: due.length, moreRemaining: due.length >= cap,
  };
}

/** Delete rows past a horizon, with each table's own exemption. */
async function pruneTable(
  policy: RetentionPolicy, cutoff: Date, cap: number, apply: boolean,
): Promise<TableResult> {
  // ============ EXEMPTIONS ARE PART OF THE POLICY ==============
  //
  // A dead-lettered job is unfinished business and the only record of it. A
  // scheduled run still marked `running` is a process that died mid-task, which
  // is the finding rather than the noise. Both survive their horizon.
  const where =
    policy.model === "job"
      ? { createdAt: { lt: cutoff }, status: { in: ["done"] } }
      : { startedAt: { lt: cutoff }, outcome: { in: ["succeeded", "failed", "skipped"] } };

  const model = policy.model === "job" ? prismaSystem.job : prismaSystem.scheduledTaskRun;

  const due = await (model as {
    findMany(args: unknown): Promise<{ id: string }[]>;
  }).findMany({
    where, select: { id: true }, take: cap,
    orderBy: policy.model === "job" ? { createdAt: "asc" } : { startedAt: "asc" },
  });

  if (!apply) {
    return {
      model: policy.model, verdict: "prune", affected: 0,
      wouldAffect: due.length, moreRemaining: due.length >= cap,
    };
  }

  const result = await (model as {
    deleteMany(args: unknown): Promise<{ count: number }>;
  }).deleteMany({ where: { id: { in: due.map((d) => d.id) } } });

  return {
    model: policy.model, verdict: "prune", affected: result.count,
    wouldAffect: due.length, moreRemaining: due.length >= cap,
  };
}

/** What each table currently holds, for an operator deciding whether to switch it on. */
export async function retentionFootprint(now = new Date()): Promise<
  { model: string; verdict: string; total: number; overdue: number; keepDays: number | null }[]
> {
  const out: { model: string; verdict: string; total: number; overdue: number; keepDays: number | null }[] = [];

  const counts: Record<string, () => Promise<{ total: number; overdue: number }>> = {
    webhookDelivery: async () => ({
      total: await prismaSystem.webhookDelivery.count(),
      overdue: await prismaSystem.webhookDelivery.count({
        where: {
          receivedAt: { lt: daysAgo(30, now) },
          status: { in: ["processed", "rejected"] },
          payload: { not: "" },
        },
      }),
    }),
    scheduledTaskRun: async () => ({
      total: await prismaSystem.scheduledTaskRun.count(),
      overdue: await prismaSystem.scheduledTaskRun.count({
        where: { startedAt: { lt: daysAgo(30, now) }, outcome: { in: ["succeeded", "failed", "skipped"] } },
      }),
    }),
    job: async () => ({
      total: await prismaSystem.job.count(),
      overdue: await prismaSystem.job.count({
        where: { createdAt: { lt: daysAgo(30, now) }, status: "done" },
      }),
    }),
    executionLog: async () => ({ total: await prismaSystem.executionLog.count(), overdue: 0 }),
    outboundOperation: async () => ({ total: await prismaSystem.outboundOperation.count(), overdue: 0 }),
    aiUsageEvent: async () => ({ total: await prismaSystem.aiUsageEvent.count(), overdue: 0 }),
    businessEvent: async () => ({ total: await prismaSystem.businessEvent.count(), overdue: 0 }),
    cognitiveOutput: async () => ({ total: await prismaSystem.cognitiveOutput.count(), overdue: 0 }),
  };

  for (const policy of RETENTION) {
    const count = counts[policy.model];
    const { total, overdue } = count ? await count() : { total: 0, overdue: 0 };
    out.push({ model: policy.model, verdict: policy.verdict, total, overdue, keepDays: policy.keepDays });
  }
  return out;
}
