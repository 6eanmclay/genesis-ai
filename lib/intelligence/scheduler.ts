import { prisma, prismaSystem } from "@/lib/prisma";
import { getConnector } from "@/lib/integrations/registry";
import { execute } from "@/lib/execution/engine";
import { syncExecutable, type SyncMetadata } from "@/lib/execution/adapters/integrationExecutable";
import { runChangeDetection } from "./changeDetection";
import { runIntelligenceCycle } from "./cycle";

// Phase 3 Milestone 3 (Business Intelligence Engine) — Part 1, the
// Scheduler. Knows nothing about any specific provider — its only inputs
// are StoreIntegration rows and a connector looked up generically via the
// existing getConnector(provider) registry (Milestone 2). The actual sync
// mechanics (connector.sync() -> persistSyncedRecords) are 100%
// Milestone 2 code, unchanged; this only decides WHEN to call it and what
// to do with the result.
//
// Deployment-agnostic by design, per Sean's explicit instruction: due-time
// is computed and stored per connector (nextSyncDueAt), independent of how
// often this module's own entry point gets invoked. A once-daily Hobby
// cron and a Pro cron running every few minutes both call the exact same
// runDueSyncs() — the only thing that changes is how quickly a backlog of
// due connectors gets worked through. An invocation that finds nothing due
// is a cheap no-op either way.

const DEFAULT_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h — the seam for
// per-provider cadence later; one global constant for now, no real need
// yet for every connector to sync on a different schedule.
const MAX_BACKOFF_MS = 24 * 60 * 60 * 1000; // 24h cap on retry backoff

/**
 * When to try this connector again, and what its failure count becomes — pure.
 *
 * Extracted (2026-08-20) because a rate limit and a broken connection deserve
 * opposite treatment and the difference was invisible inside the update call.
 * A throttled connector is HEALTHY: it answered, it just asked us to come back
 * later. Counting that as a failure walks a popular connection up the
 * exponential curve toward the 24h cap for no reason, and the owner sees a
 * connection that "stopped syncing" when nothing is wrong with it.
 */
export function nextSyncAttempt(params: {
  outcome: "success" | "rate_limited" | "failure";
  retryAfterMs?: number | null;
  failureCount: number;
  now: number;
}): { nextSyncDueAt: Date; syncFailureCount: number } {
  const { outcome, retryAfterMs, failureCount, now } = params;

  if (outcome === "success") {
    return { nextSyncDueAt: new Date(now + DEFAULT_SYNC_INTERVAL_MS), syncFailureCount: 0 };
  }

  if (outcome === "rate_limited") {
    // The provider's own instruction, when it gave one. When it did not, wait
    // a short fixed spell rather than the full 6h interval — the limit is
    // usually per-minute, so a healthy connector should not lose a whole cycle.
    const wait = retryAfterMs && retryAfterMs > 0 ? retryAfterMs : 5 * 60 * 1000;
    // The failure count is deliberately UNCHANGED, not reset: a rate limit
    // neither proves the connection works nor that it is broken, so it should
    // not clear a real failure streak either.
    return { nextSyncDueAt: new Date(now + Math.min(wait, MAX_BACKOFF_MS)), syncFailureCount: failureCount };
  }

  const nextFailureCount = failureCount + 1;
  const backoffMs = Math.min(DEFAULT_SYNC_INTERVAL_MS * 2 ** nextFailureCount, MAX_BACKOFF_MS);
  return { nextSyncDueAt: new Date(now + backoffMs), syncFailureCount: nextFailureCount };
}

// Deliberately cross-tenant — due connectors across the whole platform,
// not one store's. Only ever reached via runDueSyncs() below, itself only
// called from the CRON_SECRET-gated /api/cron/sync route — see
// lib/prisma.ts's own comment on prismaSystem for why this is the one
// query in this file that doesn't use the guarded client.
export async function getDueSyncs(limit: number) {
  const now = new Date();
  return prismaSystem.storeIntegration.findMany({
    where: {
      status: "CONNECTED",
      OR: [{ nextSyncDueAt: null }, { nextSyncDueAt: { lte: now } }],
    },
    orderBy: { nextSyncDueAt: "asc" },
    take: limit,
  });
}

export interface SyncRunSummary {
  storeId: string;
  provider: string;
  ok: boolean;
  written: number;
  errors: number;
}

// The scheduler's own entry point. `limit` is what keeps one invocation
// bounded regardless of how many stores/connectors exist — "future
// scalability for many connectors," per Sean's own requirement — a sparse
// invocation just works through more of the backlog next time.
export async function runDueSyncs(limit = 50): Promise<SyncRunSummary[]> {
  const due = await getDueSyncs(limit);
  const summaries: SyncRunSummary[] = [];
  const touchedStoreIds = new Set<string>();

  for (const integration of due) {
    const connector = getConnector(integration.provider);
    // The unattended-execution seam (lib/execution/engine.ts) — no human
    // session exists here, this is the scheduler's own storeId, verified
    // by nothing but the fact that this code path is only ever reached
    // from the CRON_SECRET-gated cron route.
    const result = await execute(syncExecutable(connector), undefined, {
      systemStoreId: integration.storeId,
    });

    // A rate limit arrives as PARTIAL carrying the provider's own timing —
    // see SyncMetadata.retryAfterMs. It is neither a success nor a failure.
    const rateLimit =
      result.status === "PARTIAL" ? (result.metadata as SyncMetadata)?.retryAfterMs : undefined;
    if (rateLimit !== undefined) {
      const next = nextSyncAttempt({
        outcome: "rate_limited",
        retryAfterMs: rateLimit,
        failureCount: integration.syncFailureCount,
        now: Date.now(),
      });
      await prisma.storeIntegration.update({
        where: { id: integration.id, storeId: integration.storeId },
        data: { nextSyncDueAt: next.nextSyncDueAt, syncFailureCount: next.syncFailureCount },
      });
      summaries.push({
        storeId: integration.storeId,
        provider: integration.provider,
        ok: false,
        written: 0,
        errors: 0,
      });
      continue;
    }

    if (result.status === "SUCCESS") {
      const next = nextSyncAttempt({
        outcome: "success",
        failureCount: integration.syncFailureCount,
        now: Date.now(),
      });
      await prisma.storeIntegration.update({
        where: { id: integration.id, storeId: integration.storeId },
        data: {
          lastSyncedAt: new Date(),
          nextSyncDueAt: next.nextSyncDueAt,
          syncFailureCount: next.syncFailureCount,
        },
      });

      const metadata = result.metadata as SyncMetadata;
      if (metadata.changes.length > 0) {
        await runChangeDetection(
          integration.storeId,
          integration.provider.toLowerCase(),
          metadata.changes
        );
      }
      touchedStoreIds.add(integration.storeId);
      summaries.push({
        storeId: integration.storeId,
        provider: integration.provider,
        ok: true,
        written: metadata.written,
        errors: metadata.errors,
      });
    } else {
      // Real retry/backoff, per Sean's explicit requirement — exponential
      // off syncFailureCount, capped, so a persistently-broken connection
      // doesn't get hammered every cycle forever.
      const next = nextSyncAttempt({
        outcome: "failure",
        failureCount: integration.syncFailureCount,
        now: Date.now(),
      });
      await prisma.storeIntegration.update({
        where: { id: integration.id, storeId: integration.storeId },
        data: {
          syncFailureCount: next.syncFailureCount,
          nextSyncDueAt: next.nextSyncDueAt,
        },
      });
      summaries.push({
        storeId: integration.storeId,
        provider: integration.provider,
        ok: false,
        written: 0,
        errors: 0,
      });
    }
  }

  // Business Intelligence Engine M1 — the cycle itself now lives in cycle.ts,
  // called identically here and from the first-party path, so a connector store
  // and a store with no integrations at all get the same engine rather than two
  // copies of the same intent that can drift apart. Nothing about what a cycle
  // does changed in that move.
  //
  // Still once per store actually synced this cycle, never once per connector.
  for (const storeId of touchedStoreIds) {
    await runIntelligenceCycle(storeId);
  }

  return summaries;
}
