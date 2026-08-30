import { prismaSystem } from "@/lib/prisma";

// HOW LONG GENESIS REMEMBERS WHAT IT DID.
//
// ============ THE PROBLEM, MEASURED (2026-08-30) ======================
//
// ProductEvent held 2,090 rows over 34 days before this milestone — about 61 a
// day, and 77% of them a single page-view event. Nothing has ever deleted one.
//
// Instrumenting execution, storage, jobs, outbound and webhooks multiplies that
// substantially: a busy day now produces an event per action, per job, per
// upload and per delivery rather than per page view. Left alone the table grows
// without bound, and the first symptom is a slow query on the one table an
// operator reaches for when something is wrong.
//
// ============ WHAT IS NOT PRUNED, EVER ================================
//
// This touches ProductEvent and nothing else, and that boundary is the whole
// design. Telemetry is an OBSERVATION and is safe to forget. These are not:
//
//   ExecutionLog            what an action did. Authoritative, and read back.
//   SecuritySignal          the security record. An attack that is only visible
//                           in hindsight needs the hindsight to still exist.
//   GrowthPointTransaction  money.
//   OutboundOperation       whether an external effect happened.
//   StorageEvent            what was deleted, and why.
//   WebhookDelivery         what a provider actually sent.
//
// A future pass may want retention on SecuritySignal too — it grows with
// attacks rather than with traffic, so it is slower and its horizon is a
// SECURITY decision about how far back an investigation should reach, not a
// storage one. Recorded here rather than silently bundled in.
//
// ============ THE WINDOW IS A PRODUCT DECISION ========================
//
// The default below is a proposal, not a ruling. Ninety days keeps a full
// quarter — long enough to compare a month against the one before it — and it
// has not been approved. Nothing schedules this; the job kind exists, dark, so
// enabling it is a decision rather than a build.

/** Proposed, not approved. See the header. */
export const DEFAULT_RETENTION_DAYS = 90;

/**
 * Events that age out faster than the rest.
 *
 * `nav.section_view` is three quarters of every row this system has ever
 * written and answers a question that stops being interesting within days:
 * which screen was opened. Keeping a quarter of it costs far more than it
 * informs, and it is the single biggest lever on the table's size.
 */
export const SHORT_RETENTION: Record<string, number> = {
  "nav.section_view": 14,
  "focus.route_resolved": 14,
  "focus.route_unresolved": 14,
};

export interface PruneResult {
  /** What would be, or was, removed — per event name. */
  removed: Record<string, number>;
  total: number;
  applied: boolean;
}

/**
 * Remove telemetry past its horizon.
 *
 * DRY BY DEFAULT. A function that deletes rows should have to be asked twice,
 * and the count it reports on a dry run is what makes the window reviewable
 * before anybody commits to it.
 */
export async function pruneTelemetry(
  opts: { now?: Date; retentionDays?: number; apply?: boolean } = {},
): Promise<PruneResult> {
  const now = opts.now ?? new Date();
  const defaultDays = opts.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const apply = opts.apply ?? false;
  const removed: Record<string, number> = {};

  const cutoffFor = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  // The short-horizon names first, each with its own window.
  for (const [name, days] of Object.entries(SHORT_RETENTION)) {
    const where = { name, createdAt: { lt: cutoffFor(days) } };
    const count = apply
      ? (await prismaSystem.productEvent.deleteMany({ where })).count
      : await prismaSystem.productEvent.count({ where });
    if (count > 0) removed[name] = count;
  }

  // Everything else, at the default horizon.
  const rest = {
    name: { notIn: Object.keys(SHORT_RETENTION) },
    createdAt: { lt: cutoffFor(defaultDays) },
  };
  const restCount = apply
    ? (await prismaSystem.productEvent.deleteMany({ where: rest })).count
    : await prismaSystem.productEvent.count({ where: rest });
  if (restCount > 0) removed["(everything else)"] = restCount;

  return {
    removed,
    total: Object.values(removed).reduce((sum, n) => sum + n, 0),
    applied: apply,
  };
}

/** What the table costs today, so the window can be argued about with numbers. */
export async function telemetryFootprint(): Promise<{
  total: number;
  oldest: Date | null;
  byName: { name: string; count: number }[];
}> {
  const [total, oldest, grouped] = await Promise.all([
    prismaSystem.productEvent.count(),
    prismaSystem.productEvent.findFirst({ orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
    prismaSystem.productEvent.groupBy({
      by: ["name"],
      _count: true,
      orderBy: { _count: { name: "desc" } },
      take: 20,
    }),
  ]);
  return {
    total,
    oldest: oldest?.createdAt ?? null,
    byName: grouped.map((g) => ({ name: g.name, count: g._count })),
  };
}
