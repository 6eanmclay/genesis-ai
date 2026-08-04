import { prisma } from "@/lib/prisma";
import { runCognitiveReview } from "@/lib/intelligence/cognitiveLayer";

// Business Intelligence Engine M2 — generalized out of the Meeting with
// J4's own recommend.ts (which is now a thin wrapper around this). Per
// Sean's explicit principle — "every future recommendation should come
// from the same ranking system," "there is only one J4" — this is THE one
// real "what's J4's single best recommendation right now" judgment,
// reusable by any future caller rather than reinvented per surface.
//
// Highest confidence (M1's confidence signal) first, then a small,
// deterministic, code-level tie-break — never a second AI judgment call —
// toward whichever near-top candidate is a create_product (Sean's own
// reasoning: something new and visible appearing is the strongest first
// experience, a tie-break heuristic, never an assumed default).
const TIE_EPSILON = 0.1;

// A candidate counts as "visible/immediate impact" only if it's a create,
// not an edit — the concrete, narrow reading of Sean's own reasoning
// (something NEW appearing), not a general ranking of every action type.
const VISIBLE_IMPACT_ACTION_TYPES = new Set(["create_product"]);

export interface NextBestAction {
  approvalRequestId: string;
  actionType: string;
  summary: string;
  confidence: number;
  // The real diff, so any inline explain/approve/execute UI can render it
  // through the exact same generic ActionDiffRows
  // (lib/execution/ActionDiff.tsx) the dashboard's ApprovalRequestsPanel
  // already uses — never a bespoke card.
  input: Record<string, unknown>;
  previousValues: Record<string, unknown>;
}

// The pure decision — separated from the DB/AI-call plumbing around it so
// it's directly testable against engineered candidate sets, not only
// observable indirectly through whatever a real model run happens to
// produce. Generic so a test can pass minimal candidates (just actionType/
// confidence) without needing to fabricate a real input/previousValues.
export function pickNextBestAction<T extends { actionType: string; confidence: number }>(
  candidates: T[]
): T | null {
  if (candidates.length === 0) {
    return null;
  }
  const ranked = [...candidates].sort((a, b) => b.confidence - a.confidence);
  const topConfidence = ranked[0].confidence;
  const nearTop = ranked.filter((c) => topConfidence - c.confidence <= TIE_EPSILON);
  const visibleAmongNearTop = nearTop.find((c) => VISIBLE_IMPACT_ACTION_TYPES.has(c.actionType));
  return visibleAmongNearTop ?? ranked[0];
}

async function candidatesToNextBestAction(
  candidates: {
    id: string;
    actionType: string;
    summary: string;
    cognitiveOutputId: string | null;
    input: unknown;
    previousValues: unknown;
  }[],
  storeId: string
): Promise<NextBestAction | null> {
  if (candidates.length === 0) {
    return null;
  }

  const cognitiveOutputIds = candidates.map((c) => c.cognitiveOutputId).filter((id): id is string => !!id);
  const outputs = await prisma.cognitiveOutput.findMany({
    where: { storeId, id: { in: cognitiveOutputIds } },
    select: { id: true, confidence: true },
  });
  const confidenceByOutputId = new Map(outputs.map((o) => [o.id, o.confidence]));

  return pickNextBestAction(
    candidates.map((c) => ({
      approvalRequestId: c.id,
      actionType: c.actionType,
      summary: c.summary,
      // Every candidate here originates from a recommendation/opportunity
      // CognitiveOutput (the only kinds that ever carry a proposedAction),
      // which M1 (Meeting with J4) made required — 0 is an honest,
      // conservative fallback for an older row written before that column
      // existed, never a crash.
      confidence: (c.cognitiveOutputId ? confidenceByOutputId.get(c.cognitiveOutputId) : null) ?? 0,
      input: c.input as Record<string, unknown>,
      previousValues: c.previousValues as Record<string, unknown>,
    }))
  );
}

// `refresh: true` — the Meeting's own need: a one-time, high-stakes moment
// where a fresh runCognitiveReview pass (reading whatever Listen/Ask just
// wrote) is worth its own real latency/cost. Scoped strictly to that
// call's own fresh outputs, not any pre-existing pending approval from an
// earlier, unrelated review — createdAt is a real, reliable boundary
// since runCognitiveReview always creates fresh rows.
//
// `refresh: false` — the right shape for any ambient/ongoing consumer
// (e.g. a future Discovery design pass): reads whatever the existing
// scheduled/opportunistic review cadence already produced, no AI call,
// near-instant. J4's answer changes over time because the scheduler/
// opportunistic triggers already keep re-running in the background
// (confirmed real and working, not this milestone's job to rebuild) — this
// path just reads the current state honestly, never manufactures freshness
// by paying for a synchronous review on every call.
export async function getNextBestAction(
  storeId: string,
  userId: string,
  opts: { refresh: boolean }
): Promise<NextBestAction | null> {
  if (opts.refresh) {
    const reviewStartedAt = new Date();
    await runCognitiveReview({ storeId, userId, background: false });
    const candidates = await prisma.approvalRequest.findMany({
      where: { storeId, status: "PENDING_APPROVAL", createdAt: { gte: reviewStartedAt } },
      select: { id: true, actionType: true, summary: true, cognitiveOutputId: true, input: true, previousValues: true },
    });
    return candidatesToNextBestAction(candidates, storeId);
  }

  const candidates = await prisma.approvalRequest.findMany({
    where: { storeId, status: "PENDING_APPROVAL" },
    orderBy: { createdAt: "desc" },
    select: { id: true, actionType: true, summary: true, cognitiveOutputId: true, input: true, previousValues: true },
  });
  return candidatesToNextBestAction(candidates, storeId);
}
