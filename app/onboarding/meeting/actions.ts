"use server";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { resolveUserStore } from "@/lib/permissions";

async function requireOwnStore() {
  const session = await auth();
  if (!session?.user) throw new Error("Not signed in");
  const resolved = await resolveUserStore(session.user.id);
  if (!resolved) throw new Error("No store to meet about yet");
  return resolved.store;
}

// Meeting with J4 M3 — the meeting's own real completion moment. Set once,
// checked once on the meeting route's own load (page.tsx), never
// re-triggered. Temporary shape: M3 only builds Reflect, so today's "real"
// completion is triggered from the Reflect beat's own Continue control;
// M4-M7 extend the same real screen with Listen/Ask/Recommend/Execute
// in between, moving where this gets called from, not what it does.
export async function completeFirstMeeting(): Promise<void> {
  const store = await requireOwnStore();
  await prisma.store.update({
    where: { id: store.id },
    data: { firstMeetingCompletedAt: new Date() },
  });
}
