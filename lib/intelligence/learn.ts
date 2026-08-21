import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { volunteeredByJ4 } from "./proposalOrigin";

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

/**
 * A belief the OWNER rejected, as distinct from one the system retired.
 *
 * `status` is a String, not an enum, and its own schema comment already treats
 * the vocabulary as open. A third value rather than a boolean because "retired
 * because it did not generalize" and "retired because the person it is about
 * says it is wrong" are different facts, and only one of them should ever come
 * back on its own.
 */
export const DISMISSED = "DISMISSED";

/**
 * The entityType that marks a belief as being about the PERSON, not the business.
 *
 * J4_OWNER_UNDERSTANDING.md's architectural insight, applied literally: this is
 * not a new mechanism, it is the existing one at a different scope. An owner
 * pattern is an ordinary Belief whose recordId is a userId.
 */
export const OWNER_ENTITY_TYPE = "owner";
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

  // A DISMISSAL BY THE OWNER OUTLIVES THE NEXT PASS (2026-08-21).
  //
  // J4_OWNER_UNDERSTANDING.md's one genuinely new requirement — "inferred
  // patterns must always be editable" — and until now it was impossible. The
  // update branch below sets status ACTIVE and clears retiredAt on every pass,
  // deliberately, so a belief reactivates on recurrence. Correct for a belief
  // the SYSTEM retired ("did not generalize"); wrong for one a PERSON rejected.
  // An owner who says "no, that isn't a pattern about me" would have watched it
  // reappear within the hour, which is worse than not offering the control.
  //
  // The rule, and it is not "suppress forever" — that would stop J4 learning:
  // a dismissed belief stays dismissed while the evidence is the evidence the
  // owner already saw and judged. If it later exceeds that, the pattern is
  // genuinely stronger than the one they rejected, and it may come back.
  //
  // NO NEW COLUMN. evidenceCount on the dismissed row already records exactly
  // how much evidence existed at the moment of dismissal.
  const existing = await prisma.belief.findUnique({
    where: { storeId_topicKey: { storeId, topicKey: params.topicKey } },
    select: { status: true, evidenceCount: true },
  });
  if (existing?.status === DISMISSED && params.supportingCount <= existing.evidenceCount) {
    return;
  }

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
      // CARRIED ON UPDATE TOO (2026-08-21). `create` set these and `update` did
      // not, so a belief first derived before its evidence carried a record
      // identity could never acquire one — it would be re-derived every pass,
      // correctly, and stay unreadable by the per-record read in reasoning.ts
      // that was built specifically to ask "what has Genesis learned about THIS
      // item?". The read has existed since Learn's Phase 2 and returned nothing
      // for a reason nobody could see from either side.
      recordId: params.recordId ?? null,
      entityType: params.entityType ?? null,
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
export interface RejectionBeliefPlan {
  topicKey: string;
  claim: string;
  supportingCount: number;
  contradictingCount: number;
  firstObservedAt: Date;
  lastConfirmedAt: Date;
  lastContradictedAt: Date | null;
  evidenceRefs: string[];
  data: { rejectionCount: number; laterExecutionCount: number };
}

// The rejection-pattern decision, separated from its database plumbing for the
// same reason nextBestAction.ts separates pickNextBestAction: the semantics
// ("whose decisions count", "how many is a pattern", "what contradicts it")
// should be provable against engineered inputs, not only observable through
// whatever a live store happens to contain.
//
// Behaviour is unchanged from before M2 except for the origin filter on the
// first line, which is the whole point of the change.
export function planRejectionBeliefs(
  rejected: {
    id: string;
    topicKey: string | null;
    decidedAt: Date | null;
    cognitiveOutputId: string | null;
  }[],
  measured: { id: string; topicKey: string | null; measuredAt: Date }[]
): RejectionBeliefPlan[] {
  const learnable = volunteeredByJ4(rejected)
    .filter((r) => r.topicKey !== null && r.decidedAt !== null)
    .sort((a, b) => a.decidedAt!.getTime() - b.decidedAt!.getTime());

  const plans: RejectionBeliefPlan[] = [];
  for (const [topicKey, group] of groupBy(learnable, (r) => r.topicKey as string)) {
    if (group.length < REJECTION_PATTERN_THRESHOLD) continue;

    const firstRejectedAt = group[0].decidedAt!;
    const lastRejectedAt = group[group.length - 1].decidedAt!;
    // A later execution of the same topicKey is real contradicting evidence
    // — the pattern of declining this didn't hold every time.
    const laterExecutions = measured.filter(
      (m) => m.topicKey === topicKey && m.measuredAt.getTime() > firstRejectedAt.getTime()
    );

    plans.push({
      topicKey,
      claim:
        laterExecutions.length > 0
          ? `The owner has declined proposals about "${topicKey}" ${group.length} time(s), but later approved one — the pattern isn't consistent, worth a different approach rather than assuming a firm no.`
          : `The owner has declined proposals about "${topicKey}" ${group.length} time(s); consider a different approach before proposing this again.`,
      supportingCount: group.length,
      contradictingCount: laterExecutions.length,
      firstObservedAt: firstRejectedAt,
      lastConfirmedAt: lastRejectedAt,
      lastContradictedAt:
        laterExecutions.length > 0 ? laterExecutions[laterExecutions.length - 1].measuredAt : null,
      evidenceRefs: [...group.map((r) => r.id), ...laterExecutions.map((m) => m.id)],
      data: { rejectionCount: group.length, laterExecutionCount: laterExecutions.length },
    });
  }
  return plans;
}

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
  //
  // M2 (2026-08-18): only proposals J4 actually VOLUNTEERED are counted. Until
  // the backfill, this filter was implicit — conversational proposals carried
  // no topicKey, so they could never group. Now that every derivable decision
  // has a canonical key, the rule has to be stated or it inverts: J4 would
  // start learning the owner's "preferences" from proposals the owner asked
  // for. Being asked about something must never create a belief.
  // WHO the pattern is about (2026-08-21). A rejection pattern was already
  // categorised "owner_preference" and had no way to say which person it
  // concerned — so "what has J4 learned about ME" was unanswerable, and the
  // privacy question the design names could not even be asked. Store.userId is
  // the owner; an employee's decisions are not evidence about them.
  const owner = await prisma.store.findUnique({ where: { id: storeId }, select: { userId: true } });

  for (const plan of planRejectionBeliefs(rejected, measured)) {
    await upsertBelief(storeId, {
      topicKey: `rejection_pattern:${plan.topicKey}`,
      claim: plan.claim,
      category: "owner_preference",
      entityType: OWNER_ENTITY_TYPE,
      recordId: owner?.userId ?? null,
      supportingCount: plan.supportingCount,
      contradictingCount: plan.contradictingCount,
      firstObservedAt: plan.firstObservedAt,
      lastConfirmedAt: plan.lastConfirmedAt,
      lastContradictedAt: plan.lastContradictedAt,
      evidenceRefs: plan.evidenceRefs,
      data: plan.data,
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

// A claim about ONE specific record doesn't need the same evidence breadth
// a store-wide trend claim does — deliberately lower than
// INSIGHT_RECURRENCE_WEEKS_THRESHOLD (3), matching the existing precedent
// that REJECTION_PATTERN_THRESHOLD/OUTCOME_PATTERN_THRESHOLD both already
// use 2 for a narrower, more specific claim.
const EVENT_RECURRENCE_WEEKS_THRESHOLD = 2;

// Detector 3 — recurring events tied to one specific record. Reads
// BusinessEvent (all time, no capped window, matching detectInsightRecurrence's
// own "all time" discipline), grouped by (eventType, recordId). recordId
// alone is the canonical, entity-agnostic identity — a BusinessRecord.id
// (or its internal-mapper equivalent) means the same thing regardless of
// which registered entity type it belongs to, so this never needs to know
// or branch on what kind of entity it's looking at; entityType is carried
// through into the belief's own field for downstream labeling, not
// because grouping needs it. The claim text is built entirely from real
// data already on the events (entityType, eventType, occurrence count, the
// latest event's own summary) — never a per-eventType special case, which
// is the one place genericness had to be deliberately designed in rather
// than assumed. The first Learn detector capable of forming a belief tied
// to one record rather than a store-wide aggregate — this is what makes
// getEntityHistory's beliefs field (Understand, reasoning.ts) return real
// content for the first time.
export async function detectRecordEventRecurrence(storeId: string): Promise<void> {
  const rows = await prisma.businessEvent.findMany({
    where: { storeId, recordId: { not: null } },
    orderBy: { occurredAt: "asc" },
  });

  const byKey = groupBy(rows, (r) => `${r.eventType}::${r.recordId}`);
  for (const [, group] of byKey) {
    const distinctWeeks = new Set(group.map((r) => weekBucket(r.occurredAt)));
    if (distinctWeeks.size < EVENT_RECURRENCE_WEEKS_THRESHOLD) continue;

    const latest = group[group.length - 1];
    const recordId = latest.recordId!;
    const eventType = latest.eventType;

    // No contradiction concept modeled here, same reasoning
    // detectInsightRecurrence already states: a resolving event (e.g.
    // "invoice.paid" after "invoice.overdue") is a different eventType
    // entirely under this grouping, so there's nothing genuine to count as
    // contradicting evidence for THIS specific pattern.
    await upsertBelief(storeId, {
      topicKey: `event_recurrence:${eventType}:${recordId}`,
      claim: `Genesis has now flagged "${eventType}" ${distinctWeeks.size} weeks in a row for this ${latest.entityType}: ${latest.summary}`,
      category: "event_recurrence",
      supportingCount: group.length,
      contradictingCount: 0,
      firstObservedAt: group[0].occurredAt,
      lastConfirmedAt: latest.occurredAt,
      lastContradictedAt: null,
      evidenceRefs: group.map((r) => r.id),
      data: { eventType, occurrences: group.length, distinctWeeks: distinctWeeks.size },
      recordId,
      entityType: latest.entityType,
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
  await detectRecordEventRecurrence(storeId);
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
export async function getBeliefs(
  storeId: string,
  opts?: {
    /**
     * Who is reading. Owner-scoped beliefs are returned only to the person they
     * are about; omitting this returns business-level beliefs only.
     */
    viewerUserId?: string | null;
  }
): Promise<
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
  // OWNER-SCOPED BELIEFS ARE NOT STORE-SCOPED KNOWLEDGE (2026-08-21).
  //
  // J4_OWNER_UNDERSTANDING.md: "an owner's own inferred behavioural profile
  // should very plausibly be visible and editable only by that owner, never
  // surfaced to an Employee-role member of the same store, even though both can
  // see the store's Business Understanding freely today."
  //
  // Business Understanding is about what the business sells. This is a model of
  // how one named person makes decisions, and it goes into prompts — so an
  // employee chatting with J4 would have heard it read back to them.
  //
  // EXCLUDED BY DEFAULT, and a caller opts in by naming the viewer. A default
  // that leaked unless someone remembered to pass a flag would be the wrong way
  // round for the more sensitive of the two.
  const rows = await prisma.belief.findMany({
    where: {
      storeId,
      status: "ACTIVE",
      // `{ not: "owner" }` ALONE IS A BUG, and the suite caught it: in SQL,
      // NOT (entityType = 'owner') evaluates to NULL — not true — for a row
      // whose entityType IS NULL, so the filter silently excluded every
      // business-level belief, which is all of them. The explicit null branch
      // is the whole difference between "not about a person" and "unknown".
      ...(opts?.viewerUserId
        ? {
            OR: [
              { entityType: null },
              { entityType: { not: OWNER_ENTITY_TYPE } },
              { recordId: opts.viewerUserId },
            ],
          }
        : { OR: [{ entityType: null }, { entityType: { not: OWNER_ENTITY_TYPE } }] }),
    },
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

/**
 * What J4 has learned about the PERSON — only ever readable by that person.
 *
 * The same shape getBeliefs returns, because it is the same mechanism: an owner
 * pattern is an ordinary Belief whose entityType is "owner". Nothing here is a
 * second store of preferences, and nothing here is written by hand — every entry
 * was derived from real decisions and re-derived on the next pass, which is what
 * makes it explainable rather than mysterious.
 *
 * Returns nothing for anyone who is not the owner. Not an error, not a partial
 * view — a person who is not the subject of these patterns has no reading of
 * them at all.
 */
export async function getOwnerUnderstanding(storeId: string, userId: string) {
  const store = await prisma.store.findUnique({ where: { id: storeId }, select: { userId: true } });
  if (!store || store.userId !== userId) return [];

  const rows = await prisma.belief.findMany({
    where: { storeId, status: "ACTIVE", entityType: OWNER_ENTITY_TYPE, recordId: userId },
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
    /** What this was inferred from. The reason it is arguable rather than opaque. */
    evidenceRefs: r.evidenceRefs,
  }));
}

/**
 * "No, that isn't a pattern about me."
 *
 * The editability J4_OWNER_UNDERSTANDING.md asks for, and the reason upsertBelief
 * now checks for DISMISSED before writing. Two properties this has to hold at
 * once, and holding only one would be worse than offering nothing:
 *
 *   it sticks   — the next distill pass will not quietly undo it
 *   it is not a permanent gag — if the evidence later grows beyond what the
 *                 owner judged, that is a genuinely different claim and J4 is
 *                 allowed to raise it again
 *
 * Only the owner may dismiss, and only a belief about themselves. An employee
 * cannot edit the owner's profile, and nobody can quietly delete a
 * business-level belief through this door — a business belief is not a personal
 * one, and retiring those stays the system's own decision.
 */
export async function dismissOwnerBelief(params: {
  storeId: string;
  beliefId: string;
  userId: string;
  reason?: string;
}): Promise<{ dismissed: boolean; why?: string }> {
  const store = await prisma.store.findUnique({
    where: { id: params.storeId },
    select: { userId: true },
  });
  if (!store || store.userId !== params.userId) {
    return { dismissed: false, why: "not_the_owner" };
  }

  const belief = await prisma.belief.findFirst({
    where: {
      id: params.beliefId,
      storeId: params.storeId,
      entityType: OWNER_ENTITY_TYPE,
      recordId: params.userId,
    },
    select: { id: true },
  });
  if (!belief) return { dismissed: false, why: "not_an_owner_belief" };

  await prisma.belief.update({
    where: { id: belief.id, storeId: params.storeId },
    data: {
      status: DISMISSED,
      retiredAt: new Date(),
      // Plain text, matching the column's own convention. Kept distinct from the
      // system's own reasons so "the owner disagreed" is never mistaken for
      // "the evidence stopped supporting it".
      retiredReason: params.reason?.trim()
        ? `dismissed by the owner: ${params.reason.trim()}`
        : "dismissed by the owner",
    },
  });

  return { dismissed: true };
}
