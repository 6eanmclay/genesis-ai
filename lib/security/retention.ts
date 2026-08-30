import { prismaSystem } from "@/lib/prisma";
import { SIGNAL_KINDS } from "./signals";

// HOW LONG A SECURITY SIGNAL IS WORTH KEEPING.
//
// ============ NOT NINETY DAYS FOR EVERYTHING (2026-08-30) ==============
//
// lib/telemetry/retention.ts keeps product events for ninety days with a
// shorter window for navigation noise, and copying that here would have been
// the easy answer and the wrong one. Telemetry answers "how is the product
// being used", where last quarter and this quarter are equally interesting.
// A security signal answers "did something happen that somebody should know
// about", and the value of that varies enormously between kinds.
//
// So the horizon is set per class, by what the signal is FOR:
//
//   AN INCIDENT, kept longest.
//     isolation.violation should be impossible. If one exists it is either a
//     defect that reached production or a breach, and either way it is the row
//     somebody wants a year later while reconstructing what happened. Anything
//     at `critical` severity is treated the same way for the same reason.
//
//   AN ACT, kept as long as what it touched.
//     webhook.replayed is a person deliberately re-running a payment delivery.
//     That is an audit record of a human decision about money, and it should
//     outlive the ordinary noise by a long way — the financial records it
//     touched are kept for years.
//
//   A PATTERN, kept long enough to see one.
//     authz.denied, authz.unresolved and webhook.unsigned are individually
//     unremarkable and collectively the clearest signal this platform has.
//     Somebody working through business slugs, or probing an endpoint, shows up
//     as a shape over weeks rather than as an event. Half a year covers a slow
//     campaign without keeping refusals for ever.
//
//   VOLUME, kept briefly.
//     http.rejected and ratelimit.tripped are the highest-volume kinds by a
//     wide margin and the least informative individually. Their value is the
//     aggregate, and it is real for about a month.
//
// ============ WHAT THIS DELIBERATELY DOES NOT DO ======================
//
// It does not roll anything up before deleting. "Was there a spike six months
// ago" is unanswerable for the short-lived kinds once they are gone, and that
// is a real loss stated rather than hidden — pre-aggregation is a second
// storage format, a second read path and a second thing to keep true, and it
// is not worth it until somebody has actually wanted that answer.

/** Days to keep, by the class a signal falls into. */
export const RETENTION_DAYS = {
  /** An incident. Kept for a full year plus a margin. */
  INCIDENT: 400,
  /** A deliberate human act on money. Kept alongside what it touched. */
  ACT: 400,
  /** A pattern that only shows up over weeks. */
  PATTERN: 180,
  /** Volume whose value is the aggregate. */
  VOLUME: 30,
} as const;

export type RetentionClass = keyof typeof RETENTION_DAYS;

/**
 * Which class a signal falls into.
 *
 * PURE, and exported, because this is the whole policy and it should be
 * readable and testable without a database. Severity outranks kind: a
 * `critical` anything is an incident whatever it was called.
 */
export function retentionClassOf(kind: string, severity: string): RetentionClass {
  // A critical signal is an incident by definition. Checked first so a future
  // kind that nobody added below still gets the safe answer.
  if (severity === "critical") return "INCIDENT";

  switch (kind) {
    case SIGNAL_KINDS.isolationViolation:
      return "INCIDENT";
    case SIGNAL_KINDS.webhookReplayed:
    case SIGNAL_KINDS.webhookReplayRefused:
      return "ACT";
    case SIGNAL_KINDS.authzDenied:
    case SIGNAL_KINDS.authzUnresolved:
    case SIGNAL_KINDS.webhookUnsigned:
    case SIGNAL_KINDS.credentialLost:
    case SIGNAL_KINDS.executionAnomaly:
      return "PATTERN";
    case SIGNAL_KINDS.rateLimited:
    case SIGNAL_KINDS.boundaryRejected:
      return "VOLUME";
    default:
      // ============ AN UNKNOWN KIND IS KEPT, NOT DROPPED =========
      //
      // A kind added later that nobody classified must not silently inherit
      // the shortest window. Keeping it too long is a storage cost; deleting
      // it too early destroys evidence, and only one of those is recoverable.
      return "PATTERN";
  }
}

export interface PruneResult {
  /** How many rows were removed, per class. */
  deleted: Record<RetentionClass, number>;
  /** True when the run stopped at its cap rather than finishing. */
  moreRemaining: boolean;
  /** What would have gone, when apply was false. */
  wouldDelete: number;
}

/** Never delete more than this in one run, whatever is due. */
export const MAX_PER_RUN = 5_000;

/**
 * Delete signals past their horizon.
 *
 * ============ BOUNDED, IDEMPOTENT, AND HONEST ABOUT STOPPING =========
 *
 * Bounded: at most MAX_PER_RUN rows per invocation, so a first run against
 * years of backlog is a series of ordinary queries rather than one statement
 * that locks a table.
 *
 * Idempotent: it deletes by age, so running it twice in a row removes nothing
 * the second time. There is no cursor to lose and no state to corrupt — the
 * only thing that decides what goes is how old a row is.
 *
 * Honest: `moreRemaining` says whether the cap was hit, so "nothing was due"
 * and "there is more than this run could take" are different answers. Without
 * it a backlog that never shrinks looks exactly like a system with nothing to
 * do, which is the same confusion the scheduler's deferred/not-due distinction
 * exists to avoid.
 */
export async function pruneSignals(
  options: { now?: Date; apply?: boolean; maxPerRun?: number } = {},
): Promise<PruneResult> {
  const now = options.now ?? new Date();
  const apply = options.apply ?? true;
  const cap = options.maxPerRun ?? MAX_PER_RUN;

  const deleted: Record<RetentionClass, number> = { INCIDENT: 0, ACT: 0, PATTERN: 0, VOLUME: 0 };
  let wouldDelete = 0;
  let budget = cap;

  // Shortest horizon first. If a run hits its cap, the rows it removed are the
  // ones with least value — a backlog should shed noise before it sheds
  // evidence.
  const order: RetentionClass[] = ["VOLUME", "PATTERN", "ACT", "INCIDENT"];

  for (const cls of order) {
    if (budget <= 0) break;
    const cutoff = new Date(now.getTime() - RETENTION_DAYS[cls] * 24 * 60 * 60 * 1000);

    // Selected by id first, so the delete is bounded by a real list rather than
    // by a predicate whose match count nobody knows in advance.
    const due = await prismaSystem.securitySignal.findMany({
      where: { occurredAt: { lt: cutoff } },
      select: { id: true, kind: true, severity: true },
      // Over-fetch a little and filter by class in memory: the class is a pure
      // function of kind and severity, and encoding it as a SQL predicate would
      // be a second copy of the policy that could disagree with the first.
      take: budget * 2,
      orderBy: { occurredAt: "asc" },
    });

    const ids = due.filter((row) => retentionClassOf(row.kind, row.severity) === cls)
      .slice(0, budget)
      .map((row) => row.id);

    if (ids.length === 0) continue;
    wouldDelete += ids.length;

    if (apply) {
      const result = await prismaSystem.securitySignal.deleteMany({ where: { id: { in: ids } } });
      deleted[cls] += result.count;
      budget -= result.count;
    } else {
      budget -= ids.length;
    }
  }

  return { deleted, moreRemaining: budget <= 0, wouldDelete };
}

/**
 * What the stream currently holds.
 *
 * The independent check on the policy: an operator can see how much of each
 * class exists and how old the oldest is, and compare that against the horizon
 * above without running anything destructive.
 */
export async function signalFootprint(now = new Date()): Promise<{
  total: number;
  oldest: Date | null;
  byClass: { class: RetentionClass; keepDays: number; count: number; overdue: number }[];
}> {
  const [total, oldestRow, rows] = await Promise.all([
    prismaSystem.securitySignal.count(),
    prismaSystem.securitySignal.findFirst({ orderBy: { occurredAt: "asc" }, select: { occurredAt: true } }),
    prismaSystem.securitySignal.groupBy({
      by: ["kind", "severity"],
      _count: true,
      _min: { occurredAt: true },
    }),
  ]);

  const byClass = new Map<RetentionClass, { count: number; overdue: number }>();
  for (const cls of Object.keys(RETENTION_DAYS) as RetentionClass[]) {
    byClass.set(cls, { count: 0, overdue: 0 });
  }

  // Overdue is counted per group rather than per row: a group whose OLDEST row
  // is inside the horizon has none overdue, and one that straddles the cutoff
  // is counted conservatively. Exact per-row counting would be a second query
  // per group for a number nobody acts on precisely.
  for (const row of rows) {
    const cls = retentionClassOf(row.kind, row.severity);
    const entry = byClass.get(cls)!;
    entry.count += row._count;
    const cutoff = new Date(now.getTime() - RETENTION_DAYS[cls] * 24 * 60 * 60 * 1000);
    if (row._min.occurredAt && row._min.occurredAt < cutoff) entry.overdue += row._count;
  }

  return {
    total,
    oldest: oldestRow?.occurredAt ?? null,
    byClass: (Object.keys(RETENTION_DAYS) as RetentionClass[]).map((cls) => ({
      class: cls,
      keepDays: RETENTION_DAYS[cls],
      count: byClass.get(cls)!.count,
      overdue: byClass.get(cls)!.overdue,
    })),
  };
}
