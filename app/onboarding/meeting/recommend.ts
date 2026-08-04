import { getNextBestAction, pickNextBestAction, type NextBestAction } from "@/lib/intelligence/nextBestAction";

// Meeting with J4 M6/M7 — Recommend, exactly one thing. Business
// Intelligence Engine M2 generalized the real selection logic (highest
// confidence, then the deterministic visible-impact tie-break) out of
// this file into lib/intelligence/nextBestAction.ts, reusable by any
// future caller — "there is only one J4," one shared ranking system, not
// a second reasoning path invented per surface. This file now just names
// the Meeting's own real need precisely: a fresh runCognitiveReview pass
// (reading whatever Listen/Ask just wrote), worth its own latency/cost
// exactly once, at this one high-stakes moment.
export type MeetingRecommendation = NextBestAction;
export const pickMeetingRecommendation = pickNextBestAction;

export async function selectMeetingRecommendation(
  storeId: string,
  userId: string
): Promise<MeetingRecommendation | null> {
  return getNextBestAction(storeId, userId, { refresh: true });
}
