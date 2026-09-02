import { prisma } from "@/lib/prisma";
import { EXECUTION_ACTIONS } from "@/lib/execution/actions";
import { recordGenesisExecution } from "@/lib/execution/genesis";
import { communicateFinding } from "@/lib/execution/genesisAutonomy";
import {
  getRecentNegativeOutcomes,
  getStaleExecutions,
  getIntegrationIssues,
} from "./needsAttention";
import { runCognitiveReview } from "@/lib/intelligence/cognitiveLayer";
import type { Insight } from "@/lib/intelligence/insights";

/**
 * How long an AI review stays fresh.
 *
 * EXPORTED (2026-09-02) so the task that selects which stores are due a review
 * asks the same question this gate answers. A second copy of the number in the
 * selector would be a second definition of "stale", and the two would drift.
 */
export const STALE_REVIEW_MS = 24 * 60 * 60 * 1000;
const CLAIM_MS = 5 * 60 * 1000;

export type ObservationState = "opportunity" | "urgent";

export interface ObservationInput {
  dedupeKey: string;
  genesisState: ObservationState;
  summary: string;
  actionHref?: string | null;
  // Phase 3 Milestone 5 — which specific BusinessRecord this observation is
  // about, when there is one. Both null (the common case, unchanged) or
  // both set — an entityType with no recordId or vice versa isn't a
  // meaningful state, so callers set them as a pair.
  recordId?: string | null;
  entityType?: string | null;
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
      recordId: obs.recordId ?? null,
      entityType: obs.entityType ?? null,
    },
    update: {
      summary: obs.summary,
      actionHref: obs.actionHref ?? null,
      recordId: obs.recordId ?? null,
      entityType: obs.entityType ?? null,
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
//
// Phase 3 Milestone 3 — dedupeKeyPrefix is now required. Before this
// milestone exactly one sweep ever owned each genesisState (deterministic
// owned "urgent", the AI review owned "opportunity"), so an unscoped
// resolve was safe. Milestone 3 adds a THIRD source — insight-driven
// notifications (lib/intelligence/notify.ts) — that can also write
// "urgent" and "opportunity" rows, so two independent sources now share
// one genesisState each. Without a namespace, either sweep's resolve pass
// would silently wipe out the other's rows (neither knows about the
// other's dedupeKeys, so "not in my active list" would incorrectly cover
// the other source's genuinely-still-active ones). Every dedupeKey a
// caller writes must start with the same prefix it resolves with.
export async function resolveMissingObservations(
  storeId: string,
  stillActiveDedupeKeys: string[],
  genesisState: ObservationState,
  dedupeKeyPrefix: string
): Promise<void> {
  await prisma.genesisObservation.updateMany({
    where: {
      storeId,
      genesisState,
      status: "ACTIVE",
      dedupeKey: { startsWith: dedupeKeyPrefix, notIn: stillActiveDedupeKeys },
    },
    data: { status: "RESOLVED", resolvedAt: new Date() },
  });
}

const DETERMINISTIC_PREFIX = "deterministic:";

// The deterministic sweep — zero AI cost, plain DB reads. Reuses the
// existing recentOutcomes-kind functions from needsAttention.ts verbatim;
// deliberately never getStateIssues (routine setup state stays Business
// Journey's job, positively framed — it must never also become an alarming
// Red signal). Safe to call from every opportunistic trigger point.
//
// First constitutional compliance fix (post-Phase-3 audit) — GenesisObservation
// itself is legitimate Embodiment Layer/Expression (a presentation cache with
// its own dedup/auto-resolve semantics, unchanged below), but every finding
// it displays must first exist as a real CognitiveOutput, produced through
// communicateFinding()/Execute, before Expression ever projects it. These
// urgent items are exactly what the Insight Engine already means by
// kind: "insight" (deterministic, real, computed findings, never AI
// judgment) — they were just never recorded as one. Only communicated once
// per still-active occurrence: an already-ACTIVE CognitiveOutput for a
// topicKey means the condition is already durably recorded and doesn't need
// re-communicating on every sweep (this runs far more often than the
// once-daily-gated AI review — recording a fresh row every call would flood
// the table with duplicates for the same ongoing problem). Once it resolves
// and later genuinely recurs, a fresh row is created — real, spaced-out
// recurrence, exactly what Learn's detectInsightRecurrence is designed to
// notice over time, not incidental noise.
export async function runDeterministicObservationSweep(storeId: string): Promise<void> {
  const [recentFailures, staleExecutions, integrationIssues] = await Promise.all([
    getRecentNegativeOutcomes(storeId),
    getStaleExecutions(storeId),
    getIntegrationIssues(storeId),
  ]);
  const urgentItems = [...recentFailures, ...staleExecutions, ...integrationIssues];
  const currentTopicKeys = urgentItems.map((item) => `${DETERMINISTIC_PREFIX}${item.id}`);

  const alreadyActive = await prisma.cognitiveOutput.findMany({
    where: { storeId, topicKey: { in: currentTopicKeys }, status: "ACTIVE" },
    select: { topicKey: true },
  });
  const alreadyActiveTopicKeys = new Set(alreadyActive.map((r) => r.topicKey as string));

  for (const item of urgentItems) {
    const topicKey = `${DETERMINISTIC_PREFIX}${item.id}`;
    if (!alreadyActiveTopicKeys.has(topicKey)) {
      await communicateFinding(storeId, {
        kind: "insight",
        summary: item.message,
        priority: "high",
        actionHref: item.actionHref ?? null,
        topicKey,
      });
    }
    await upsertObservation(storeId, {
      dedupeKey: topicKey,
      genesisState: "urgent",
      summary: item.message,
      actionHref: item.actionHref ?? null,
    });
  }

  await resolveMissingObservations(storeId, currentTopicKeys, "urgent", DETERMINISTIC_PREFIX);

  // The CognitiveOutput side resolves in parallel with the badge side —
  // closing out an already-recorded finding is bookkeeping on an existing
  // row, not originating a new one, so this is a direct update rather than
  // another communicateFinding call (the same distinction Phase 1/2 already
  // established for superseding stale predictions).
  await prisma.cognitiveOutput.updateMany({
    where: {
      storeId,
      topicKey: { startsWith: DETERMINISTIC_PREFIX, notIn: currentTopicKeys },
      status: "ACTIVE",
    },
    data: { status: "RESOLVED", resolvedAt: new Date() },
  });
}

const AI_REVIEW_PREFIX = "ai_review:";

/**
 * One review finding, as the observation it becomes.
 *
 * ============ WHY THIS IS A FUNCTION (2026-09-02) =====================
 *
 * It was an object literal inside the call below, which made the Tier 1
 * change — carrying the review's own `recordId` through instead of dropping
 * it — impossible to test without a live model behind `runCognitiveReview`.
 *
 * SABOTAGE PROVED THE TESTS WERE HOLLOW. Setting `recordId` back to null at
 * the call site left the suite green, because every check was calling
 * `upsertObservation` directly and so was measuring the storage helper, which
 * had always stored what it was handed. The mapping is the thing this
 * milestone changed, so the mapping is what has to be callable.
 *
 * THE DEDUPE KEY LIVES HERE TOO, and deliberately: identity is
 * `${AI_REVIEW_PREFIX}${topicKey}` and nothing else. A key that folded in the
 * recordId would make a finding that gains a record into a SECOND row, and
 * would desynchronise the resolve sweep below — which builds its list from
 * this same function for exactly that reason.
 */
export function observationFromReview(r: {
  topicKey: string;
  message: string;
  actionHref: string;
  recordId: string | null;
  entityType: "goal" | "challenge" | "asset" | null;
}): ObservationInput {
  return {
    dedupeKey: `${AI_REVIEW_PREFIX}${r.topicKey}`,
    genesisState: "opportunity",
    summary: r.message,
    actionHref: r.actionHref,
    // WHAT IT IS ABOUT, where the review genuinely knew. Already resolved and
    // validated inside runCognitiveReview against the records the model was
    // actually shown; carried here rather than recomputed. Null for the
    // majority of findings, which are about the business rather than about one
    // record — and null is what keeps them off every entity card.
    recordId: r.recordId,
    entityType: r.entityType,
  };
}

// The AI-gated trigger. Meant to be invoked via next/server's after(), never
// awaited inline — see the Phase 4 plan for why that keeps Home's response
// unblocked while staying within the "no scheduler/queue/worker" boundary.
export async function runOpportunisticAiReviewIfStale(
  storeId: string,
  // Phase 3 Milestone 3 — nullable so the scheduler's unattended cycle can
  // call this too, alongside the existing after()-driven human path.
  userId: string | null,
  // Pre-computed by the scheduler (see runCognitiveReview's own comment for
  // why computeInsights must not run twice) — undefined for the existing
  // after()-driven human path, which has none to pass.
  recentInsights?: Insight[],
  // Daily Operating Rhythm — threaded straight through to runCognitiveReview
  // unchanged; see that function's own comment. undefined for the
  // scheduler's cron call site, so a cron-triggered review never composes
  // a briefing.
  composeBriefingForUserId?: string | null
): Promise<void> {
  // Staleness reads the latest matching ExecutionLog row, not a
  // CognitiveOutput/GeneratedRecommendation timestamp — a genuine
  // zero-output review would produce no new row either way, which would
  // make a healthy store look stale forever. recordGenesisExecution's
  // SUCCESS row is written unconditionally (zero results or not), so it's
  // the real durable "reviewed at time T" signal. A recent PENDING row is
  // treated as "another request already claimed this" — best-effort concurrency
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

  const recommendations = await runCognitiveReview({
    storeId,
    userId,
    recentInsights,
    composeBriefingForUserId,
  });

  // Only "high" priority becomes a Purple ambient signal — keeps it as
  // narrow/high-signal as Red, never "a recommendation row happens to
  // exist" (most reviews produce at least a medium/low item; that alone
  // shouldn't light up the ambient pill).
  const highPriority = recommendations.filter((r) => r.priority === "high");
  await Promise.all(
    highPriority.map((r) => upsertObservation(storeId, observationFromReview(r)))
  );
  await resolveMissingObservations(
    storeId,
    // THE SAME EXPRESSION THAT WROTE THEM. Building this list separately is
    // how a write key and a resolve key drift apart, and the cost of drifting
    // is every AI-review row being resolved the moment it is written.
    recommendations.map((r) => observationFromReview(r).dedupeKey),
    "opportunity",
    AI_REVIEW_PREFIX
  );
}
