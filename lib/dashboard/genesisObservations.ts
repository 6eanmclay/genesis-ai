import { prisma } from "@/lib/prisma";
import { EXECUTION_ACTIONS } from "@/lib/execution/actions";
import { recordGenesisExecution } from "@/lib/execution/genesis";
import {
  getRecentNegativeOutcomes,
  getStaleExecutions,
  getIntegrationIssues,
} from "./needsAttention";
import { generateGenesisRecommendations } from "./generateGenesisRecommendations";

const STALE_REVIEW_MS = 24 * 60 * 60 * 1000;
const CLAIM_MS = 5 * 60 * 1000;

export type ObservationState = "opportunity" | "urgent";

export interface ObservationInput {
  dedupeKey: string;
  genesisState: ObservationState;
  summary: string;
  actionHref?: string | null;
}

// Upserts by (storeId, dedupeKey) — the entire dedup mechanism. Re-detecting
// the same real condition bumps lastConfirmedAt and refreshes the text
// rather than creating a duplicate row or re-notifying. Reactivates a
// previously RESOLVED row if the same condition recurs, so identity
// survives a resolve/reappear cycle instead of spawning a second row for
// the same real thing.
export async function upsertObservation(storeId: string, obs: ObservationInput): Promise<void> {
  await prisma.genesisObservation.upsert({
    where: { storeId_dedupeKey: { storeId, dedupeKey: obs.dedupeKey } },
    create: {
      storeId,
      dedupeKey: obs.dedupeKey,
      genesisState: obs.genesisState,
      summary: obs.summary,
      actionHref: obs.actionHref ?? null,
    },
    update: {
      summary: obs.summary,
      actionHref: obs.actionHref ?? null,
      status: "ACTIVE",
      lastConfirmedAt: new Date(),
      resolvedAt: null,
      dismissedAt: null,
    },
  });
}

// Marks every currently-ACTIVE observation of this genesisState that isn't
// in the fresh set as RESOLVED — called once per sweep, after computing the
// current true set, so anything that stopped being true disappears without
// anyone telling Genesis to stop mentioning it.
export async function resolveMissingObservations(
  storeId: string,
  stillActiveDedupeKeys: string[],
  genesisState: ObservationState
): Promise<void> {
  await prisma.genesisObservation.updateMany({
    where: {
      storeId,
      genesisState,
      status: "ACTIVE",
      dedupeKey: { notIn: stillActiveDedupeKeys },
    },
    data: { status: "RESOLVED", resolvedAt: new Date() },
  });
}

// The deterministic sweep — zero AI cost, plain DB reads. Reuses the
// existing recentOutcomes-kind functions from needsAttention.ts verbatim;
// deliberately never getStateIssues (routine setup state stays Business
// Journey's job, positively framed — it must never also become an alarming
// Red signal). Safe to call from every opportunistic trigger point.
export async function runDeterministicObservationSweep(storeId: string): Promise<void> {
  const [recentFailures, staleExecutions, integrationIssues] = await Promise.all([
    getRecentNegativeOutcomes(storeId),
    getStaleExecutions(storeId),
    getIntegrationIssues(storeId),
  ]);
  const urgentItems = [...recentFailures, ...staleExecutions, ...integrationIssues];

  await Promise.all(
    urgentItems.map((item) =>
      upsertObservation(storeId, {
        dedupeKey: item.id,
        genesisState: "urgent",
        summary: item.message,
        actionHref: item.actionHref ?? null,
      })
    )
  );
  await resolveMissingObservations(
    storeId,
    urgentItems.map((item) => item.id),
    "urgent"
  );
}

// The AI-gated trigger. Meant to be invoked via next/server's after(), never
// awaited inline — see the Phase 4 plan for why that keeps Home's response
// unblocked while staying within the "no scheduler/queue/worker" boundary.
export async function runOpportunisticAiReviewIfStale(storeId: string, userId: string): Promise<void> {
  // Staleness reads the latest matching ExecutionLog row, not
  // GeneratedRecommendation.generatedAt — that function's transaction is
  // [deleteMany, ...creates], so a genuine zero-recommendation review
  // creates no new row and generatedAt never advances, which would make a
  // healthy store look stale forever. recordGenesisExecution's SUCCESS row
  // is written unconditionally (zero results or not), so it's the real
  // durable "reviewed at time T" signal. A recent PENDING row is treated as
  // "another request already claimed this" — best-effort concurrency
  // control, not an airtight lock (see the plan for why that tradeoff is
  // fine here: the bounded failure mode is an extra Claude call in a narrow
  // race, never corrupted data).
  const recentRun = await prisma.executionLog.findFirst({
    where: {
      storeId,
      action: EXECUTION_ACTIONS.GENESIS_RECOMMENDATIONS_GENERATE,
      OR: [
        { status: "SUCCESS" },
        { status: "PENDING", createdAt: { gte: new Date(Date.now() - CLAIM_MS) } },
      ],
    },
    orderBy: { createdAt: "desc" },
  });

  const isStale =
    !recentRun || (recentRun.status === "SUCCESS" && Date.now() - recentRun.createdAt.getTime() > STALE_REVIEW_MS);
  if (!isStale) return;

  // Claim immediately — narrows the race window to the few milliseconds
  // between the read above and this write, not the duration of the Claude
  // call itself.
  await recordGenesisExecution({
    action: EXECUTION_ACTIONS.GENESIS_RECOMMENDATIONS_GENERATE,
    status: "PENDING",
    verified: false,
    message: "Starting opportunistic business review",
    retryable: false,
    userId,
    storeId,
    metadata: {},
  });

  const recommendations = await generateGenesisRecommendations({ storeId, userId });

  // Only "high" priority becomes a Purple ambient signal — keeps it as
  // narrow/high-signal as Red, never "a recommendation row happens to
  // exist" (most reviews produce at least a medium/low item; that alone
  // shouldn't light up the ambient pill).
  const highPriority = recommendations.filter((r) => r.priority === "high");
  await Promise.all(
    highPriority.map((r) =>
      upsertObservation(storeId, {
        dedupeKey: r.topicKey,
        genesisState: "opportunity",
        summary: r.message,
        actionHref: r.actionHref,
      })
    )
  );
  await resolveMissingObservations(
    storeId,
    recommendations.map((r) => r.topicKey),
    "opportunity"
  );
}
