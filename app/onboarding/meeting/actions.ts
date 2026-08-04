"use server";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { resolveUserStore } from "@/lib/permissions";
import { extractAndPersistVisionFacts } from "./listen";

async function requireOwnStore() {
  const session = await auth();
  if (!session?.user) throw new Error("Not signed in");
  const resolved = await resolveUserStore(session.user.id);
  if (!resolved) throw new Error("No store to meet about yet");
  return resolved.store;
}

// Meeting with J4 M4 — Listen's own real submission. Extracts and persists
// whatever real goals/challenges the owner's open answer actually
// contained (zero is a valid, honest outcome), then — temporarily, until
// M5 adds Ask — completes the meeting the same way Reflect's Continue used
// to. M5 replaces this chain with a real "ask only if genuinely needed"
// decision in between; this function's own extraction logic doesn't change.
export async function submitMeetingVision(visionText: string): Promise<void> {
  const store = await requireOwnStore();
  const trimmed = visionText.trim();
  if (trimmed) {
    await extractAndPersistVisionFacts(store.id, trimmed);
  }
  await completeFirstMeeting();
}

// The meeting's own real completion moment. Set once, checked once on the
// meeting route's own load (page.tsx), never re-triggered. Called from
// submitMeetingVision above as of M4 — M5-M7 move the call further still
// (Ask, then Recommend/Execute) as each real stage gets built; this
// function itself doesn't change.
export async function completeFirstMeeting(): Promise<void> {
  const store = await requireOwnStore();
  await prisma.store.update({
    where: { id: store.id },
    data: { firstMeetingCompletedAt: new Date() },
  });
}
