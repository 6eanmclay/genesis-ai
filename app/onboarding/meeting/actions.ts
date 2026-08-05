"use server";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { resolveUserStore } from "@/lib/permissions";
import { rewardReferralIfEligible } from "@/lib/growthPoints/referral";
import { grantBusinessPartnerTrialIfEligible } from "@/lib/growthPoints/trial";
import { extractAndPersistVisionFacts } from "./listen";
import { decideNextMeetingStep, type FollowUpTurn } from "./ask";
import { selectMeetingRecommendation, type MeetingRecommendation } from "./recommend";
import { performApproveGenesisAction, performRejectGenesisAction } from "@/app/dashboard/ai-actions";

async function requireOwnStore() {
  const session = await auth();
  if (!session?.user) throw new Error("Not signed in");
  const resolved = await resolveUserStore(session.user.id);
  if (!resolved) throw new Error("No store to meet about yet");
  return { store: resolved.store, userId: session.user.id };
}

export type MeetingTurnResult =
  | { action: "ask"; question: string }
  | { action: "recommend"; recommendation: MeetingRecommendation }
  // No real, actionable candidate existed — handled honestly, the meeting
  // completes without fabricating something to recommend.
  | { action: "done" };

// Meeting with J4 M5-M7 — one real turn of Listen/Ask, shared by both the
// initial "what do you want this to become" answer and any follow-up.
// Extracts and persists whatever real goals/challenges the answer actually
// contained (zero is a valid, honest outcome), then asks decideNextMeetingStep
// whether one more question is genuinely warranted. Once the conversation
// is done, M6's selectMeetingRecommendation reasons over this store's own
// now-enriched understanding for the single highest-confidence real
// recommendation — the meeting only ever completes directly (no
// recommendation stage) when there's honestly nothing real to propose.
export async function submitMeetingTurn(
  transcript: FollowUpTurn[],
  question: string,
  answer: string
): Promise<MeetingTurnResult> {
  const { store, userId } = await requireOwnStore();
  const trimmed = answer.trim();
  if (trimmed) {
    await extractAndPersistVisionFacts(store.id, trimmed);
  }

  const updatedTranscript = [...transcript, { question, answer: trimmed }];
  const decision = await decideNextMeetingStep(store.id, updatedTranscript);
  if (decision.action === "ask") {
    return { action: "ask", question: decision.question };
  }

  const recommendation = await selectMeetingRecommendation(store.id, userId);
  if (!recommendation) {
    await completeFirstMeeting();
    return { action: "done" };
  }
  return { action: "recommend", recommendation };
}

export type MeetingDecisionResult = { message: string; executed: boolean };

// Meeting with J4 M7 — Explain, approve, execute, immediately, in the same
// conversation. Reuses ai-actions.ts's own real approve/reject logic (the
// exact same path the dashboard's ApprovalRequestsPanel uses) rather than
// a parallel meeting-only implementation — the general framework Sean
// asked for, proven end to end back in M2. Completes the meeting either
// way: approving or declining are both a real, respected decision, not a
// prerequisite to finishing.
export async function approveMeetingRecommendation(approvalRequestId: string): Promise<MeetingDecisionResult> {
  const result = await performApproveGenesisAction(approvalRequestId);
  await completeFirstMeeting();
  if (result.outcome === "execution_failed") {
    return { message: result.message, executed: false };
  }
  if (result.outcome === "executed") {
    return { message: result.message, executed: true };
  }
  return { message: "That's already been decided.", executed: false };
}

export async function declineMeetingRecommendation(approvalRequestId: string): Promise<MeetingDecisionResult> {
  const result = await performRejectGenesisAction(approvalRequestId);
  await completeFirstMeeting();
  return { message: "No problem — I'll leave it as is.", executed: result.outcome !== "not_found" };
}

// The meeting's own real completion moment. Set once, checked once on the
// meeting route's own load (page.tsx), never re-triggered.
export async function completeFirstMeeting(): Promise<void> {
  const { store, userId } = await requireOwnStore();
  await prisma.store.update({
    where: { id: store.id },
    data: { firstMeetingCompletedAt: new Date() },
  });
  // Growth Points Economy (Chapter 2) — this is the real "onboarding
  // genuinely finished" signal a referral reward waits for, not bare
  // signup. A no-op for the overwhelming majority who arrived without a
  // referral code.
  await rewardReferralIfEligible(userId);
  // Business Partner Preview — the same real completion signal grants the
  // store's one-time 7-day trial (a no-op if this account already has an
  // active trial elsewhere, or if this store already has one).
  await grantBusinessPartnerTrialIfEligible(userId, { id: store.id, name: store.name });
}
