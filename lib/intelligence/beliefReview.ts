import { prisma } from "@/lib/prisma";
import { describeMaturity, DISMISSED, OWNER_ENTITY_TYPE } from "./learn";

// WHAT J4 BELIEVES, WHERE THE OWNER CAN SEE IT AND ARGUE WITH IT
// (2026-08-22, J4's Understanding milestone, U4).
//
// THE GAP THIS CLOSES, and it is a trust property rather than a feature.
// getBeliefs had exactly one consumer — getBusinessUnderstanding — and that
// feeds prompts. So J4 reasoned from conclusions about somebody's business
// that the person could not read, correct, or contradict. "J4 makes better
// entrepreneurs" is hard to square with holding beliefs about someone's
// business behind their back.
//
// The Understanding screen did show claims, read-only, and its own comment
// named the gap: "A real correction UI is named future work". Three things were
// missing and each matters on its own — the EVIDENCE behind a claim, the DATES
// that say whether it still holds, and any way to say "no, that's wrong".
//
// WHAT IS DELIBERATELY NOT HERE.
//
// No "confirm". Sean asked for correct/contradict/retire, and a confirm button
// would have to do something — bump confidence, add evidence — that nothing
// could compute honestly. Confidence is derived from real evidence by
// computeConfidence; a number nudged by a click is no longer that.
//
// No rewriting a claim into the owner's words. A belief is DERIVED, and a
// sentence the owner typed is STATED — putting one in the other's field makes a
// first-party fact read as a machine's conclusion, which is exactly the
// confusion RecordProvenance exists to prevent. An owner who wants to say what
// is actually true states a fact (lib/businessModel/statements.ts); this door
// only ever marks a conclusion wrong.
//
// No chain-of-thought. The evidence below is resolved into the owner-facing
// summaries those rows ALREADY carry and show elsewhere in the product. Nothing
// here surfaces a prompt, a model's working, or an internal id.

/** One thing that actually happened, described the way the product already describes it. */
export interface BeliefEvidence {
  kind: "finding" | "event" | "measurement" | "decision";
  summary: string;
  occurredAt: Date;
}

export interface ReviewableBelief {
  id: string;
  claim: string;
  category: string;
  categoryLabel: string;
  confidence: number;
  maturity: string;
  evidenceCount: number;
  /** The real rows behind it, as the owner would see them anywhere else. */
  evidence: BeliefEvidence[];
  /**
   * How many supporting rows could not be resolved.
   *
   * Reported rather than hidden. Evidence can be legitimately gone — a
   * CognitiveOutput superseded, an event pruned — and a list that silently
   * shrank would make a belief look thinner than the number beside it says.
   * Two silences are not the same silence.
   */
  evidenceMissing: number;
  firstObservedAt: Date;
  lastConfirmedAt: Date;
  lastContradictedAt: Date | null;
  /** True when this is a pattern about the PERSON, not the business. */
  aboutYou: boolean;
  /** Set only on a belief the owner has already contradicted. */
  contradictedReason: string | null;
}

/**
 * What each category means, in the owner's language.
 *
 * A hand-maintained mirror of the categories lib/intelligence/learn.ts actually
 * writes — ARCHITECTURE.md's standing invariant, and the failure it names has
 * happened before in this exact shape: a kind with no label reaching a fallback
 * that renders the raw string at a merchant. scripts/verify-belief-review.ts
 * cross-checks this against learn.ts's own source.
 */
export const BELIEF_CATEGORY_LABEL: Record<string, string> = {
  insight_recurrence: "Something that keeps coming up",
  owner_preference: "A pattern in your decisions",
  outcome_pattern: "What tends to happen when you act",
  event_recurrence: "Something your business does repeatedly",
};

/** The fallback is a sentence, never the raw key. */
export function categoryLabel(category: string): string {
  return BELIEF_CATEGORY_LABEL[Object.hasOwn(BELIEF_CATEGORY_LABEL, category) ? category : ""] ?? "A pattern J4 noticed";
}

/**
 * Turn evidence ids into things a person can recognise.
 *
 * FOUR TABLES, because four detectors write beliefs and each groups a different
 * kind of real row. Every one of them already has an owner-facing summary that
 * this product shows elsewhere, which is what makes this safe: nothing here
 * invents a description or exposes anything the owner could not already see.
 *
 * EVERY QUERY IS STORE-SCOPED. An evidence id is just a string on a row, with no
 * foreign key behind it, so resolving one without a storeId would happily return
 * another tenant's finding and print it as this business's evidence.
 */
async function resolveEvidence(
  storeId: string,
  refs: string[]
): Promise<{ items: BeliefEvidence[]; missing: number }> {
  if (refs.length === 0) return { items: [], missing: 0 };

  // Capped, because a long-held belief can accumulate many and a review screen
  // needs the shape of the evidence, not all of it. The count beside it is the
  // full number, so nothing is misrepresented by showing fewer.
  const ids = refs.slice(0, 200);

  const [findings, events, measurements, decisions] = await Promise.all([
    prisma.cognitiveOutput.findMany({
      where: { storeId, id: { in: ids } },
      select: { id: true, summary: true, generatedAt: true },
    }),
    prisma.businessEvent.findMany({
      where: { storeId, id: { in: ids } },
      select: { id: true, summary: true, occurredAt: true },
    }),
    prisma.postExecutionMeasurement.findMany({
      where: { storeId, id: { in: ids } },
      select: { id: true, summary: true, measuredAt: true },
    }),
    prisma.approvalRequest.findMany({
      where: { storeId, id: { in: ids } },
      select: { id: true, summary: true, createdAt: true },
    }),
  ]);

  const items: BeliefEvidence[] = [
    ...findings.map((r) => ({ kind: "finding" as const, summary: r.summary, occurredAt: r.generatedAt })),
    ...events.map((r) => ({ kind: "event" as const, summary: r.summary, occurredAt: r.occurredAt })),
    ...measurements.map((r) => ({ kind: "measurement" as const, summary: r.summary, occurredAt: r.measuredAt })),
    ...decisions.map((r) => ({ kind: "decision" as const, summary: r.summary, occurredAt: r.createdAt })),
  ].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());

  return { items, missing: Math.max(refs.length - items.length, 0) };
}

/**
 * Every belief the owner is entitled to see, with what stands behind it.
 *
 * Owner-scoped beliefs (patterns about the PERSON) are included only for the
 * person they are about — the same rule getBeliefs already enforces, and for the
 * same reason: an employee of the same store has no reading of a model of how
 * their employer makes decisions.
 */
export async function getReviewableBeliefs(
  storeId: string,
  viewerUserId: string
): Promise<{ active: ReviewableBelief[]; contradicted: ReviewableBelief[] }> {
  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: { userId: true },
  });
  const isOwner = store?.userId === viewerUserId;

  const rows = await prisma.belief.findMany({
    where: {
      storeId,
      status: { in: ["ACTIVE", DISMISSED] },
      // The explicit null branch is load-bearing: in SQL, NOT (entityType =
      // 'owner') is NULL — not true — for a row whose entityType IS NULL, which
      // is every business-level belief. learn.ts records this exact bug being
      // caught by its own suite.
      ...(isOwner
        ? {}
        : { OR: [{ entityType: null }, { entityType: { not: OWNER_ENTITY_TYPE } }] }),
    },
    orderBy: { lastConfirmedAt: "desc" },
  });

  const reviewed = await Promise.all(
    rows.map(async (r) => {
      const { items, missing } = await resolveEvidence(storeId, r.evidenceRefs);
      const belief: ReviewableBelief & { status: string } = {
        id: r.id,
        claim: r.claim,
        category: r.category,
        categoryLabel: categoryLabel(r.category),
        confidence: r.confidence,
        maturity: describeMaturity(r),
        evidenceCount: r.evidenceCount,
        evidence: items,
        evidenceMissing: missing,
        firstObservedAt: r.firstObservedAt,
        lastConfirmedAt: r.lastConfirmedAt,
        lastContradictedAt: r.lastContradictedAt,
        aboutYou: r.entityType === OWNER_ENTITY_TYPE,
        contradictedReason: r.status === DISMISSED ? r.retiredReason : null,
        status: r.status,
      };
      return belief;
    })
  );

  return {
    active: reviewed.filter((b) => b.status === "ACTIVE").map(stripStatus),
    contradicted: reviewed.filter((b) => b.status === DISMISSED).map(stripStatus),
  };
}

function stripStatus(b: ReviewableBelief & { status: string }): ReviewableBelief {
  const { status: _status, ...rest } = b;
  void _status;
  return rest;
}

export type ContradictOutcome =
  | { ok: true }
  | { ok: false; refusal: "not_permitted" | "unknown_belief" };

/**
 * The owner says a belief is wrong.
 *
 * REUSES THE PROVEN DURABILITY RULE rather than inventing one. upsertBelief
 * already refuses to resurrect a DISMISSED belief while `supportingCount <=
 * evidenceCount` — "a dismissed belief stays dismissed while the evidence is
 * the evidence the owner already saw and judged" — so a correction survives the
 * next distillation pass without a new column or a suppression list. It is not
 * "suppress forever", which would stop J4 learning: evidence genuinely stronger
 * than what the owner judged may bring the pattern back.
 *
 * DISMISSED, NOT RETIRED, and the distinction is the whole point. RETIRED is the
 * system's own outcome — the evidence stopped supporting it. DISMISSED is a
 * person disagreeing. Collapsing them would let "the owner said no" read back
 * later as "it didn't generalise", and the two call for opposite responses.
 *
 * EXTENDS dismissOwnerBelief rather than duplicating it. That function covers
 * beliefs about the PERSON and deliberately refused business-level ones on the
 * grounds that "retiring those stays the system's own decision" — a reasonable
 * line at the time and one Sean has since moved: the owner must be able to
 * contradict what J4 believes about their business too. Its own guarantees are
 * kept intact here: only the owner may act, and only within their own store.
 */
export async function contradictBelief(params: {
  storeId: string;
  beliefId: string;
  userId: string;
  /** The owner's own words. Stored verbatim, never parsed. */
  note?: string;
}): Promise<ContradictOutcome> {
  const store = await prisma.store.findUnique({
    where: { id: params.storeId },
    select: { userId: true },
  });
  // OWNER ONLY. An employee marking the business's beliefs wrong is a different
  // decision with different stakes, and nobody has asked for it.
  if (!store || store.userId !== params.userId) {
    return { ok: false, refusal: "not_permitted" };
  }

  const belief = await prisma.belief.findFirst({
    // storeId in the WHERE clause. A belief id alone is unique, so scoping by it
    // and checking the store afterwards would be a cross-tenant write that
    // returns successfully.
    where: { id: params.beliefId, storeId: params.storeId },
    select: { id: true },
  });
  if (!belief) return { ok: false, refusal: "unknown_belief" };

  const note = params.note?.trim();
  await prisma.belief.update({
    where: { id: belief.id, storeId: params.storeId },
    data: {
      status: DISMISSED,
      retiredAt: new Date(),
      // Plain text, matching the column's convention and dismissOwnerBelief's
      // own wording, so one reader can tell an owner's disagreement from the
      // system's own retirement without knowing which door it came through.
      retiredReason: note ? `dismissed by the owner: ${note}` : "dismissed by the owner",
    },
  });

  return { ok: true };
}

/**
 * The owner changes their mind about a contradiction.
 *
 * Restores the belief to ACTIVE and clears the reason, which is the honest
 * inverse: nothing about the evidence changed, so nothing about confidence or
 * counts should. A belief brought back this way is exactly the belief that was
 * there before it was contradicted.
 */
export async function restoreBelief(params: {
  storeId: string;
  beliefId: string;
  userId: string;
}): Promise<ContradictOutcome> {
  const store = await prisma.store.findUnique({
    where: { id: params.storeId },
    select: { userId: true },
  });
  if (!store || store.userId !== params.userId) {
    return { ok: false, refusal: "not_permitted" };
  }

  const belief = await prisma.belief.findFirst({
    where: { id: params.beliefId, storeId: params.storeId, status: DISMISSED },
    select: { id: true },
  });
  if (!belief) return { ok: false, refusal: "unknown_belief" };

  await prisma.belief.update({
    where: { id: belief.id, storeId: params.storeId },
    data: { status: "ACTIVE", retiredAt: null, retiredReason: null },
  });
  return { ok: true };
}
