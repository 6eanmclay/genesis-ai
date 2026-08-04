import { prisma } from "@/lib/prisma";
import { runCognitiveReview } from "@/lib/intelligence/cognitiveLayer";

// Meeting with J4 M6 — Recommend, exactly one thing. Reuses runCognitiveReview
// wholesale, scoped to this store, now reading the real goals/challenges
// Listen (M4) just wrote — no new reasoning logic, the same "enrich the
// inputs, not Reason itself" discipline this architecture already holds
// everywhere else. Candidates are the real ApprovalRequest rows this exact
// call creates (only recommendation/opportunity items with a real,
// registered proposedAction ever produce one — informational-only findings
// correctly never become a candidate here), ranked by the confidence signal
// (M1), with a small, deterministic, code-level tie-break — never a second
// AI judgment call — toward whichever candidate is a create_product (Sean's
// own reasoning: something new and visible appearing is the strongest
// first experience, a tie-break heuristic, never an assumed default).
const TIE_EPSILON = 0.1;

// A candidate counts as "visible/immediate impact" only if it's a create,
// not an edit — the concrete, narrow reading of Sean's own reasoning
// (something NEW appearing), not a general ranking of every action type.
const VISIBLE_IMPACT_ACTION_TYPES = new Set(["create_product"]);

export interface MeetingRecommendation {
  approvalRequestId: string;
  actionType: string;
  summary: string;
  confidence: number;
}

// The pure decision — highest confidence, then the deterministic
// visible-impact tie-break — separated from the DB/AI-call plumbing around
// it so it's directly testable against engineered candidate sets, not only
// observable indirectly through whatever a real model run happens to
// produce.
export function pickMeetingRecommendation(candidates: MeetingRecommendation[]): MeetingRecommendation | null {
  if (candidates.length === 0) {
    return null;
  }
  const ranked = [...candidates].sort((a, b) => b.confidence - a.confidence);
  const topConfidence = ranked[0].confidence;
  const nearTop = ranked.filter((c) => topConfidence - c.confidence <= TIE_EPSILON);
  const visibleAmongNearTop = nearTop.find((c) => VISIBLE_IMPACT_ACTION_TYPES.has(c.actionType));
  return visibleAmongNearTop ?? ranked[0];
}

export async function selectMeetingRecommendation(
  storeId: string,
  userId: string
): Promise<MeetingRecommendation | null> {
  const reviewStartedAt = new Date();
  await runCognitiveReview({ storeId, userId, background: false });

  // Scoped strictly to this run's own outputs, not any pre-existing pending
  // approval from an earlier, unrelated review — createdAt is a real,
  // reliable boundary since runCognitiveReview always creates fresh rows.
  const candidates = await prisma.approvalRequest.findMany({
    where: { storeId, status: "PENDING_APPROVAL", createdAt: { gte: reviewStartedAt } },
    select: { id: true, actionType: true, summary: true, cognitiveOutputId: true },
  });
  if (candidates.length === 0) {
    return null;
  }

  const cognitiveOutputIds = candidates.map((c) => c.cognitiveOutputId).filter((id): id is string => !!id);
  const outputs = await prisma.cognitiveOutput.findMany({
    where: { storeId, id: { in: cognitiveOutputIds } },
    select: { id: true, confidence: true },
  });
  const confidenceByOutputId = new Map(outputs.map((o) => [o.id, o.confidence]));

  return pickMeetingRecommendation(
    candidates.map((c) => ({
      approvalRequestId: c.id,
      actionType: c.actionType,
      summary: c.summary,
      // Every candidate here originates from a recommendation/opportunity
      // CognitiveOutput (the only kinds that ever carry a proposedAction),
      // which M1 made required — 0 is an honest, conservative fallback for
      // an older row written before that column existed, never a crash.
      confidence: (c.cognitiveOutputId ? confidenceByOutputId.get(c.cognitiveOutputId) : null) ?? 0,
    }))
  );
}
