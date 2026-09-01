import { prismaSystem } from "@/lib/prisma";

// KEEPING THE BUSINESS FACT AND LETTING THE VISITOR RECORD GO.
//
// ============ THE POLICY, AND WHY IT IS A PARAMETER (2026-09-01) =======
//
// Sean: "Do not retain raw StoreVisit rows indefinitely by default. Use 12
// months as the initial raw-visit retention period, but make the retention
// policy explicit/configurable rather than hard-coding an irreversible
// assumption."
//
// So the number is a named constant with an override on every entry point. It
// is a decision, and a decision somebody may revisit — not a magic 365 buried
// in a delete.
//
// ============ AND WHY THE ROLLUP IS NOT A SEPARATE JOB =================
//
// Sean: "Longer-lived business facts/aggregates derived from the raw visits
// should be treated separately from raw visitor telemetry."
//
// Orders carry their own frozen attribution for ever, so revenue by source
// survives pruning on its own. What would NOT survive is the visit COUNT — and
// without it there is no conversion rate and no revenue per visitor, which are
// two of the four numbers this milestone exists to make possible.
//
// A separate nightly rollup job would work right up until the day it did not
// run, and the prune would then delete counts nothing had recorded. So the
// rollup happens INSIDE the prune, before the delete, in the same call. The
// destructive step cannot run without the preserving one, because it is the
// same step.
//
// ============ NOTHING SCHEDULES THIS ==================================
//
// Deliberately not registered with lib/scheduler. Sean's standing instruction
// is that no retention or prune task gets enabled without his say-so, and this
// one deletes a merchant's own traffic history. It is callable, proven, and
// dormant.

/** Twelve months. Sean's number, 2026-09-01. */
export const RAW_VISIT_RETENTION_DAYS = 365;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Midnight UTC of the day a timestamp falls in. */
export function dayOf(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

export interface RollupResult {
  /** Distinct (day, kind, source) buckets written or updated. */
  buckets: number;
  /** Raw visits that contributed. */
  visits: number;
}

/**
 * Summarise visits into durable daily traffic facts.
 *
 * IDEMPOTENT. Rolling the same window twice writes the same numbers, because
 * each bucket is upserted to an absolute count rather than incremented. A
 * retried prune must not double a merchant's traffic.
 */
export async function rollUpVisits(params: {
  before: Date;
  storeId?: string;
}): Promise<RollupResult> {
  const where = {
    firstSeenAt: { lt: params.before },
    ...(params.storeId ? { storeId: params.storeId } : {}),
  };

  const visits = await prismaSystem.storeVisit.findMany({
    where,
    select: { storeId: true, attributionKind: true, source: true, firstSeenAt: true },
  });

  const buckets = new Map<string, { storeId: string; day: Date; kind: string; source: string; visits: number }>();
  for (const visit of visits) {
    const day = dayOf(visit.firstSeenAt);
    // EMPTY STRING, not null: nulls are distinct in a Postgres unique index, so
    // a nullable source would insert a new direct-traffic row on every rollup
    // instead of updating the one that exists. See the schema.
    const source = visit.source ?? "";
    const key = `${visit.storeId}|${day.toISOString()}|${visit.attributionKind}|${source}`;
    const existing = buckets.get(key);
    if (existing) existing.visits += 1;
    else buckets.set(key, { storeId: visit.storeId, day, kind: visit.attributionKind, source, visits: 1 });
  }

  for (const bucket of buckets.values()) {
    await prismaSystem.storeTrafficDay.upsert({
      where: {
        storeId_day_attributionKind_source: {
          storeId: bucket.storeId,
          day: bucket.day,
          attributionKind: bucket.kind,
          source: bucket.source,
        },
      },
      // ABSOLUTE, not an increment. A rollup re-run over the same window is a
      // correction, not more traffic.
      update: { visits: bucket.visits },
      create: {
        storeId: bucket.storeId,
        day: bucket.day,
        attributionKind: bucket.kind,
        source: bucket.source,
        visits: bucket.visits,
      },
    });
  }

  return { buckets: buckets.size, visits: visits.length };
}

export interface PruneResult extends RollupResult {
  deleted: number;
  before: Date;
  retentionDays: number;
}

/**
 * Roll up, then delete. In that order, in one call.
 *
 * Returns what it preserved as well as what it removed, so a caller can see
 * that the trade actually happened rather than trusting that it did.
 */
export async function pruneStoreVisits(opts: {
  retentionDays?: number;
  now?: Date;
  storeId?: string;
} = {}): Promise<PruneResult> {
  const retentionDays = opts.retentionDays ?? RAW_VISIT_RETENTION_DAYS;
  const now = opts.now ?? new Date();
  const before = new Date(now.getTime() - retentionDays * DAY_MS);

  // PRESERVE FIRST. If this throws, nothing is deleted and the history is
  // still there to try again with.
  const rolled = await rollUpVisits({ before, storeId: opts.storeId });

  const { count } = await prismaSystem.storeVisit.deleteMany({
    where: {
      firstSeenAt: { lt: before },
      ...(opts.storeId ? { storeId: opts.storeId } : {}),
    },
  });

  return { ...rolled, deleted: count, before, retentionDays };
}
