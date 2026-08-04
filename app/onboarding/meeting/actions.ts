"use server";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { resolveUserStore } from "@/lib/permissions";
import { extractAndPersistVisionFacts } from "./listen";
import { decideNextMeetingStep, type FollowUpTurn } from "./ask";

async function requireOwnStore() {
  const session = await auth();
  if (!session?.user) throw new Error("Not signed in");
  const resolved = await resolveUserStore(session.user.id);
  if (!resolved) throw new Error("No store to meet about yet");
  return resolved.store;
}

export type MeetingTurnResult = { action: "ask"; question: string } | { action: "proceed" };

// Meeting with J4 M5 — one real turn of Listen/Ask, shared by both the
// initial "what do you want this to become" answer and any follow-up
// (there's no structural difference between them — each answer gets
// extracted for real facts the same way, then the same real judgment call
// decides whether one more question is genuinely warranted). Extracts and
// persists whatever real goals/challenges the answer actually contained
// (zero is a valid, honest outcome for either), appends the turn to the
// transcript, then asks decideNextMeetingStep whether to continue.
// Temporarily — until M6 adds Recommend — "proceed" completes the meeting
// directly; M6-M7 move that further still, this function's own logic
// doesn't change.
export async function submitMeetingTurn(
  transcript: FollowUpTurn[],
  question: string,
  answer: string
): Promise<MeetingTurnResult> {
  const store = await requireOwnStore();
  const trimmed = answer.trim();
  if (trimmed) {
    await extractAndPersistVisionFacts(store.id, trimmed);
  }

  const updatedTranscript = [...transcript, { question, answer: trimmed }];
  const decision = await decideNextMeetingStep(store.id, updatedTranscript);
  if (decision.action === "ask") {
    return { action: "ask", question: decision.question };
  }
  await completeFirstMeeting();
  return { action: "proceed" };
}

// The meeting's own real completion moment. Set once, checked once on the
// meeting route's own load (page.tsx), never re-triggered. Called from
// submitMeetingTurn above as of M5 — M6-M7 move the call further still
// (Recommend/Execute) as each real stage gets built; this function itself
// doesn't change.
export async function completeFirstMeeting(): Promise<void> {
  const store = await requireOwnStore();
  await prisma.store.update({
    where: { id: store.id },
    data: { firstMeetingCompletedAt: new Date() },
  });
}
