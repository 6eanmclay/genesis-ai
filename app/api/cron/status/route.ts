import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/auth/cronAuth";
import { prismaSystem } from "@/lib/prisma";
import { INSIGHT_ENGINE_CONSUMER } from "@/lib/intelligence/insights";
import { EXECUTION_ACTIONS } from "@/lib/execution/actions";

// Read-only companion to /api/cron/sync — reports each connected
// integration's own sync-scheduling state directly, since the sync route's
// synced/failed counts can't say *which* connector last ran without this.
//
// AND, SINCE 2026-08-24, WHETHER THE INTELLIGENCE ENGINE IS ACTUALLY RUNNING.
//
// That could not be answered from production at all. The cron route returns its
// summary as an HTTP response body to Vercel and nothing persists it; no
// cycle-run model exists; /admin reports AI cost only. So "is the BI engine
// running?" had no answer that did not involve tailing runtime logs and hoping.
//
// Nothing new is written to make this answerable. Every field below is read
// from rows the engine ALREADY writes as part of doing its job:
//
//   BusinessEventCursor  how far the Insight Engine has consumed — lag against
//                        the store's newest event is exactly the "due" signal
//                        cycle.ts's own selectDueStoreIds uses
//   CognitiveOutput      the last thing the engine concluded, and when
//   ExecutionLog         the AI review's own durable SUCCESS/FAILED record
//
// A store that appears here with lag and no recent output is the shape of a
// problem. A store with no lag is working. Neither required a new table.
// Same CRON_SECRET gate; no side effects. Deliberately cross-tenant (every
// connected integration on the platform, not one store's) — the real
// authorization is the CRON_SECRET header check above, not a storeId
// filter, so this uses prismaSystem rather than the tenant-isolation-
// guarded client — see lib/prisma.ts's own comment on that export.
export async function GET(request: NextRequest) {
  // Fails CLOSED when CRON_SECRET is unset — see lib/auth/cronAuth.ts. The
  // inline comparison this replaced compared against the literal string
  // "Bearer undefined" in that case, which anyone could send.
  if (!isAuthorizedCronRequest(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [integrations, intelligence] = await Promise.all([
    connectedIntegrations(),
    intelligenceState(),
  ]);

  return NextResponse.json({ integrations, intelligence });
}

async function connectedIntegrations() {
  return prismaSystem.storeIntegration.findMany({
    where: { status: "CONNECTED" },
    select: {
      storeId: true,
      provider: true,
      status: true,
      lastSyncedAt: true,
      nextSyncDueAt: true,
      syncFailureCount: true,
      lastError: true,
    },
    orderBy: { lastSyncedAt: "desc" },
  });
}

/**
 * Per-store intelligence state, from rows the engine already writes.
 *
 * Cross-tenant for the same reason the integration read above is: the question
 * is "which stores across the platform are behind", which no single store's
 * scoped client can ask. The authorization is the CRON_SECRET check, not a
 * storeId filter.
 */
async function intelligenceState() {
  const [activity, cursors, lastOutputs, lastReviews] = await Promise.all([
    prismaSystem.businessEvent.groupBy({ by: ["storeId"], _max: { sequence: true } }),
    prismaSystem.businessEventCursor.findMany({
      where: { consumerName: INSIGHT_ENGINE_CONSUMER },
      select: { storeId: true, lastProcessedSequence: true, updatedAt: true },
    }),
    prismaSystem.cognitiveOutput.groupBy({ by: ["storeId"], _max: { generatedAt: true } }),
    prismaSystem.executionLog.findMany({
      where: { action: EXECUTION_ACTIONS.GENESIS_RECOMMENDATIONS_GENERATE },
      select: { storeId: true, status: true, message: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: 500,
    }),
  ]);

  const consumed = new Map(cursors.map((c) => [c.storeId, c]));
  const lastOutput = new Map(lastOutputs.map((o) => [o.storeId, o._max?.generatedAt ?? null]));
  // First per store wins — the list is already newest-first.
  const lastReview = new Map<string, (typeof lastReviews)[number]>();
  for (const row of lastReviews) {
    if (row.storeId && !lastReview.has(row.storeId)) lastReview.set(row.storeId, row);
  }

  return activity
    .filter((a) => a._max.sequence !== null)
    .map((a) => {
      const cursor = consumed.get(a.storeId);
      const review = lastReview.get(a.storeId);
      return {
        storeId: a.storeId,
        // How many events the Insight Engine has not consumed. Zero means the
        // engine is caught up; a number that keeps growing across days is the
        // engine not running, or failing at its first stage every time.
        eventLag: Number((a._max.sequence as bigint) - (cursor?.lastProcessedSequence ?? BigInt(0))),
        cursorUpdatedAt: cursor?.updatedAt ?? null,
        // Null is a real answer — a store that has genuinely never produced a
        // cognitive output, not a gap in this report.
        lastCognitiveOutputAt: lastOutput.get(a.storeId) ?? null,
        lastAiReview: review
          ? { status: review.status, at: review.createdAt, message: review.message }
          : null,
      };
    })
    .sort((a, b) => b.eventLag - a.eventLag);
}
