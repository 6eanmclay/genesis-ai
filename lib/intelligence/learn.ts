import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// J4 Foundation Phase 2 — the Learn cognitive subsystem. Continuously
// distills accumulated experience (Understand's facts as they change,
// Execute's outcome records) into a compact, current, revisable set of
// beliefs — never facts, never judgments about what to do, just "what have
// we learned." See the Learn subsystem specification (memory:
// project_j4_cognitive_architecture.md) for the full contract this file
// implements: only Learn may generalize across time; only Learn may revise
// or retire a belief; nothing here ever acts or speaks directly — every
// output is read, later, by Reason alone.
//
// Deliberately deterministic, matching the Insight Engine's own "100%
// deterministic, no AI judgment" discipline (lib/intelligence/insights.ts)
// extended to generalization: a belief's claim is built from real computed
// numbers, never invented, and every belief is fully re-derived from real
// evidence on every pass rather than incrementally patched — so a belief
// can never silently drift from what the raw evidence actually shows.

const EVIDENCE_SATURATION_COUNT = 5; // occurrences beyond this add diminishing confidence, not none
const INSIGHT_RECURRENCE_WEEKS_THRESHOLD = 3; // real recurrence needs distinct weeks, not a same-day burst
const REJECTION_PATTERN_THRESHOLD = 2;
const OUTCOME_PATTERN_THRESHOLD = 2;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// A real, named, defensible formula (matching insights.ts's own threshold
// discipline), not a magic number. A single supporting instance produces
// real but modest confidence (0.2 at saturation=5), never a false-strong
// signal from one data point — this is what keeps a fresh, thin belief from
// reading as confidently as a long-tested one purely because of how it's
// scored; evidenceCount/duration are tracked and exposed separately for
// exactly that reason, never folded into this one number.
export function computeConfidence(supportingCount: number, contradictingCount: number): number {
  const breadth = Math.min(1, supportingCount / EVIDENCE_SATURATION_COUNT);
  const total = supportingCount + contradictingCount;
  const contradictionPenalty = total > 0 ? contradictingCount / total : 0;
  return Math.max(0, breadth * (1 - contradictionPenalty));
}

interface UpsertBeliefParams {
  topicKey: string;
  claim: string;
  category: string;
  supportingCount: number;
  contradictingCount: number;
  firstObservedAt: Date;
  lastConfirmedAt: Date;
  lastContradictedAt: Date | null;
  evidenceRefs: string[];
  data?: object;
  recordId?: string | null;
  entityType?: string | null;
}

// The Belief analog of upsertObservation() (genesisObservations.ts) — read
// current state, compute the diff, write once. Every detector recomputes
// its counts fresh from real evidence on every pass (never incrementing a
// stored counter), so this is a full overwrite of the derived fields, not a
// patch — a belief can never accumulate drift between what's stored and
// what the evidence actually shows. Reactivates a previously RETIRED belief
// on recurrence, matching the same reactivate-on-recurrence convention
// upsertObservation already established for GenesisObservation.
async function upsertBelief(storeId: string, params: UpsertBeliefParams): Promise<void> {
  const confidence = computeConfidence(params.supportingCount, params.contradictingCount);
  await prisma.belief.upsert({
    where: { storeId_topicKey: { storeId, topicKey: params.topicKey } },
    create: {
      storeId,
      topicKey: params.topicKey,
      claim: params.claim,
      category: params.category,
      confidence,
      evidenceCount: params.supportingCount,
      firstObservedAt: params.firstObservedAt,
      lastConfirmedAt: params.lastConfirmedAt,
      lastContradictedAt: params.lastContradictedAt,
      evidenceRefs: params.evidenceRefs,
      data: params.data ? (params.data as Prisma.InputJsonValue) : Prisma.DbNull,
      recordId: params.recordId ?? null,
      entityType: params.entityType ?? null,
    },
    update: {
      claim: params.claim,
      confidence,
      evidenceCount: params.supportingCount,
      lastConfirmedAt: params.lastConfirmedAt,
      lastContradictedAt: params.lastContradictedAt,
      evidenceRefs: params.evidenceRefs,
      data: params.data ? (params.data as Prisma.InputJsonValue) : Prisma.DbNull,
      status: "ACTIVE",
      retiredAt: null,
      retiredReason: null,
    },
  });
}

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const existing = map.get(k);
    if (existing) existing.push(item);
    else map.set(k, [item]);
  }
  return map;
}

// A rolling 7-day bucket, not a calendar week — the point is only to
// distinguish "spread across real time" from "a same-day burst," not to
// align with any particular week-start convention.
function weekBucket(date: Date): number {
  return Math.floor(date.getTime() / WEEK_MS);
}

// Detector 1 — recurring insights. Reads CognitiveOutput (kind: "insight"),
// grouped by topicKey (insight.type, e.g. "revenue.decreased" — see
// insights.ts's own communicateFinding call for why topicKey carries this).
// Deliberately reads ALL time, never a capped recency window — the exact
// thing getRecentGenesisHistory's 60-day/5-item cap could never do. This is
// the literal realization of "this is the third week in a row."
export async function detectInsightRecurrence(storeId: string): Promise<void> {
  const rows = await prisma.cognitiveOutput.findMany({
    where: { storeId, kind: "insight", topicKey: { not: null } },
    orderBy: { generatedAt: "asc" },
  });

  const byTopicKey = groupBy(rows, (r) => r.topicKey as string);
  for (const [topicKey, group] of byTopicKey) {
    const distinctWeeks = new Set(group.map((r) => weekBucket(r.generatedAt)));
    if (distinctWeeks.size < INSIGHT_RECURRENCE_WEEKS_THRESHOLD) continue;

    const latest = group[group.length - 1];
    // No contradiction concept modeled for this detector yet — an opposite-
    // direction insight (e.g. revenue.increased) is a different topicKey
    // entirely under today's grouping, so there's nothing genuine to count
    // as contradicting evidence here. Left honestly at 0 rather than forcing
    // a concept that doesn't really exist for this pattern.
    await upsertBelief(storeId, {
      topicKey: `insight_recurrence:${topicKey}`,
      claim: `Genesis has now flagged this ${distinctWeeks.size} weeks in a row: ${latest.summary}`,
      category: "insight_recurrence",
      supportingCount: group.length,
      contradictingCount: 0,
      firstObservedAt: group[0].generatedAt,
      lastConfirmedAt: latest.generatedAt,
      lastContradictedAt: null,
      evidenceRefs: group.map((r) => r.id),
      data: { insightType: topicKey, occurrences: group.length, distinctWeeks: distinctWeeks.size },
    });
  }
}

type Direction = "positive" | "negative" | "neutral";

function measurementDirection(m: {
  revenueBeforeCents: number | null;
  revenueAfterCents: number | null;
  orderCountBefore: number;
  orderCountAfter: number;
}): Direction {
  if (m.revenueBeforeCents !== null && m.revenueAfterCents !== null) {
    if (m.revenueAfterCents > m.revenueBeforeCents) return "positive";
    if (m.revenueAfterCents < m.revenueBeforeCents) return "negative";
    return "neutral";
  }
  if (m.orderCountAfter > m.orderCountBefore) return "positive";
  if (m.orderCountAfter < m.orderCountBefore) return "negative";
  return "neutral";
}

// Detector 2 — decision/outcome patterns, from the exact two real sources
// getRecentGenesisHistory already reads (PostExecutionMeasurement, rejected
// ApprovalRequest), all time rather than a 60-day/5-item cap, grouped by
// topicKey. Two distinct belief shapes, both genuinely evidence-bearing:
//
// 1. Rejection pattern — 2+ declines of the same topicKey become a real,
//    computed "the owner tends to say no to this" belief, turning today's
//    implicit prompt instruction ("don't blindly repeat a rejected
//    proposal") into something Reason can actually consult rather than hope
//    the model remembers correctly from raw history text. A LATER executed
//    proposal for the same topicKey counts as genuine contradicting
//    evidence — the owner changed their mind — lowering confidence and
//    setting lastContradictedAt, never silently ignored.
// 2. Outcome correlation — 2+ measured executions of the same topicKey
//    whose before/after direction agrees become a belief describing the
//    correlation, with the same non-causal framing
//    PostExecutionMeasurement.summary already enforces verbatim carried
//    into the claim text — Learn is not allowed to launder a correlation
//    into a causal claim just by aggregating it.
export async function detectDecisionOutcomePattern(storeId: string): Promise<void> {
  const [measured, rejected] = await Promise.all([
    prisma.postExecutionMeasurement.findMany({
      where: { storeId, topicKey: { not: null } },
      orderBy: { measuredAt: "asc" },
    }),
    prisma.approvalRequest.findMany({
      where: { storeId, status: "REJECTED", topicKey: { not: null } },
      orderBy: { decidedAt: "asc" },
    }),
  ]);

  // --- Rejection patterns ---
  const rejectedByTopic = groupBy(rejected, (r) => r.topicKey as string);
  for (const [topicKey, group] of rejectedByTopic) {
    if (group.length < REJECTION_PATTERN_THRESHOLD) continue;

    const firstRejectedAt = group[0].decidedAt!;
    const lastRejectedAt = group[group.length - 1].decidedAt!;
    // A later execution of the same topicKey is real contradicting evidence
    // — the pattern of declining this didn't hold every time.
    const laterExecutions = measured.filter(
      (m) => m.topicKey === topicKey && m.measuredAt.getTime() > firstRejectedAt.getTime()
    );

    await upsertBelief(storeId, {
      topicKey: `rejection_pattern:${topicKey}`,
      claim:
        laterExecutions.length > 0
          ? `The owner has declined proposals about "${topicKey}" ${group.length} time(s), but later approved one — the pattern isn't consistent, worth a different approach rather than assuming a firm no.`
          : `The owner has declined proposals about "${topicKey}" ${group.length} time(s); consider a different approach before proposing this again.`,
      category: "owner_preference",
      supportingCount: group.length,
      contradictingCount: laterExecutions.length,
      firstObservedAt: firstRejectedAt,
      lastConfirmedAt: lastRejectedAt,
      lastContradictedAt:
        laterExecutions.length > 0
          ? laterExecutions[laterExecutions.length - 1].measuredAt
          : null,
      evidenceRefs: [...group.map((r) => r.id), ...laterExecutions.map((m) => m.id)],
      data: { rejectionCount: group.length, laterExecutionCount: laterExecutions.length },
    });
  }

  // --- Outcome correlations ---
  const measuredByTopic = groupBy(measured, (m) => m.topicKey as string);
  for (const [topicKey, group] of measuredByTopic) {
    if (group.length < OUTCOME_PATTERN_THRESHOLD) continue;

    const directions = group.map((m) => measurementDirection(m));
    const positive = directions.filter((d) => d === "positive").length;
    const negative = directions.filter((d) => d === "negative").length;
    if (positive === 0 && negative === 0) continue; // every measurement neutral — nothing to say

    const majorityDirection: Direction = positive >= negative ? "positive" : "negative";
    const supportingCount = majorityDirection === "positive" ? positive : negative;
    const contradictingCount = majorityDirection === "positive" ? negative : positive;
    if (supportingCount < OUTCOME_PATTERN_THRESHOLD) continue;

    const directionWord = majorityDirection === "positive" ? "an increase" : "a decrease";
    // Confirming and contradicting evidence are tracked by their OWN most
    // recent timestamp, never by "whichever measurement happens to be
    // chronologically last" — a belief's lastConfirmedAt must keep pointing
    // at the last time it was genuinely reaffirmed even if a more recent,
    // contradicting measurement has since arrived; that gap between the two
    // timestamps is exactly what makes a Reconsideration signal visible
    // rather than silently averaged away.
    const confirmingEntries = group.filter((_m, i) => directions[i] === majorityDirection);
    const contradictingEntries = group.filter(
      (_m, i) => directions[i] !== majorityDirection && directions[i] !== "neutral"
    );

    await upsertBelief(storeId, {
      topicKey: `outcome_pattern:${topicKey}`,
      claim: `${supportingCount} of the last ${group.length} times Genesis acted on "${topicKey}", the following window showed ${directionWord} in orders or revenue. This is correlated timing, not proof the action caused it.`,
      category: "outcome_pattern",
      supportingCount,
      contradictingCount,
      firstObservedAt: group[0].measuredAt,
      lastConfirmedAt: confirmingEntries[confirmingEntries.length - 1].measuredAt,
      lastContradictedAt:
        contradictingEntries.length > 0
          ? contradictingEntries[contradictingEntries.length - 1].measuredAt
          : null,
      evidenceRefs: group.map((m) => m.id),
      data: { positive, negative, total: group.length },
    });
  }
}

// The single entry point every trigger site calls — mirrors computeInsights'
// own call shape exactly. Deliberately called ALONGSIDE computeInsights,
// never from inside Reason (runCognitiveReview) itself and never triggered
// only when Reason happens to run — Learn has to stay continuous/ambient,
// not collapse into "whatever Reason's cadence happens to be."
export async function distillBeliefs(storeId: string): Promise<void> {
  await detectInsightRecurrence(storeId);
  await detectDecisionOutcomePattern(storeId);
}

const MATURE_DURATION_DAYS_THRESHOLD = 30; // real, named — "well-established" needs breadth AND time, not one alone
const DAY_MS = 24 * 60 * 60 * 1000;

// J4 Foundation Phase 3 (Reason) — the derived read Learn's own "no stored
// maturity stage" invariant depends on: computed fresh from real signals
// every time, never an independently authored or persisted category. A
// belief "being reconsidered" — the most recent real evidence contradicted
// it, after a run of confirmations — takes priority over evidence count,
// because a belief that just broke matters more than how long it used to
// hold. Written generally enough to handle a belief with evidenceCount
// below any detector's own creation threshold, even though none of today's
// two detectors (learn.ts) ever create one that low yet.
export function describeMaturity(belief: {
  evidenceCount: number;
  firstObservedAt: Date;
  lastConfirmedAt: Date;
  lastContradictedAt: Date | null;
}): string {
  const isBeingReconsidered =
    belief.lastContradictedAt !== null &&
    belief.lastContradictedAt.getTime() > belief.lastConfirmedAt.getTime();
  if (isBeingReconsidered) {
    return "being reconsidered — this held for a while but was recently contradicted";
  }
  if (belief.evidenceCount < 2) {
    return "early signal — only one supporting instance so far";
  }
  const daysHeld = (belief.lastConfirmedAt.getTime() - belief.firstObservedAt.getTime()) / DAY_MS;
  if (belief.evidenceCount >= EVIDENCE_SATURATION_COUNT && daysHeld >= MATURE_DURATION_DAYS_THRESHOLD) {
    return "well-established — tested repeatedly over time";
  }
  return "an emerging pattern — real, but still building evidence";
}

// Reason's read contract — the only way Reason may ever consume Learn's
// output. Includes the derived maturity label directly so every caller
// gets it for free, never computes its own notion of maturity separately.
export async function getBeliefs(storeId: string): Promise<
  {
    id: string;
    topicKey: string;
    claim: string;
    category: string;
    confidence: number;
    maturity: string;
    evidenceCount: number;
    firstObservedAt: Date;
    lastConfirmedAt: Date;
    lastContradictedAt: Date | null;
  }[]
> {
  const rows = await prisma.belief.findMany({
    where: { storeId, status: "ACTIVE" },
    orderBy: { lastConfirmedAt: "desc" },
  });
  return rows.map((r) => ({
    id: r.id,
    topicKey: r.topicKey,
    claim: r.claim,
    category: r.category,
    confidence: r.confidence,
    maturity: describeMaturity(r),
    evidenceCount: r.evidenceCount,
    firstObservedAt: r.firstObservedAt,
    lastConfirmedAt: r.lastConfirmedAt,
    lastContradictedAt: r.lastContradictedAt,
  }));
}
