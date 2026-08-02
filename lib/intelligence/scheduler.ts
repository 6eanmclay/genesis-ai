import { prisma, prismaSystem } from "@/lib/prisma";
import { getConnector } from "@/lib/integrations/registry";
import { execute } from "@/lib/execution/engine";
import { syncExecutable, type SyncMetadata } from "@/lib/execution/adapters/integrationExecutable";
import { runChangeDetection } from "./changeDetection";
import { computeInsights } from "./insights";
import { notifyFromInsights } from "./notify";
import { runOpportunisticAiReviewIfStale } from "@/lib/dashboard/genesisObservations";

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

    if (result.status === "SUCCESS") {
      await prisma.storeIntegration.update({
        where: { id: integration.id, storeId: integration.storeId },
        data: {
          lastSyncedAt: new Date(),
          nextSyncDueAt: new Date(Date.now() + DEFAULT_SYNC_INTERVAL_MS),
          syncFailureCount: 0,
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
      const nextFailureCount = integration.syncFailureCount + 1;
      const backoffMs = Math.min(
        DEFAULT_SYNC_INTERVAL_MS * 2 ** nextFailureCount,
        MAX_BACKOFF_MS
      );
      await prisma.storeIntegration.update({
        where: { id: integration.id, storeId: integration.storeId },
        data: {
          syncFailureCount: nextFailureCount,
          nextSyncDueAt: new Date(Date.now() + backoffMs),
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

  // Insight Engine -> Recommendation Engine -> Notifications, once per
  // store actually synced this cycle — never once per connector. Insights
  // include time-based conditions (overdue invoices, trend windows
  // crossing a week boundary) that can become newly significant purely
  // from time passing, so this still runs even for a connector whose sync
  // produced zero new changes this cycle.
  for (const storeId of touchedStoreIds) {
    const insights = await computeInsights(storeId);
    await notifyFromInsights(storeId, insights);

    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: { userId: true },
    });
    // The real store owner, not null — more informative in ExecutionLog
    // than an anonymous actorId, and readily available; this doesn't
    // change actorType (still always "GENESIS", see recordGenesisExecution),
    // it only attributes the review to the real business it's about.
    await runOpportunisticAiReviewIfStale(storeId, store?.userId ?? null, insights);
  }

  return summaries;
}
