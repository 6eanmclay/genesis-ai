import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { PERMISSIONS, hasPermission } from "@/lib/permissions";
import { resolveBusiness } from "@/lib/businessContext";
import { getPendingApprovals } from "@/lib/dashboard/pendingApprovals";
import { sendStoreMessage, uploadVoiceMemo } from "@/app/dashboard/ai-actions";
import { J4Room } from "./J4Room";

// Reliability hardening — same real evidence as app/j4/page.tsx: Vercel's
// real function ceiling is 300s (Fluid Compute), not the old assumed 10s.
// sendStoreMessage calls real AI, same durations class as the Workspace.
export const maxDuration = 300;

// J4 Room, Phase 1 (2026-08-08) — "Workspace = work with J4, Room = talk
// with J4" (Sean). A new, separate, immersive screen, not a mode of /j4 —
// entered via the doorway button in the Workspace's own composer
// (J4Workspace.tsx), exited back to /j4. Deliberately reuses the exact
// same StoreMessage data and server actions (sendStoreMessage,
// uploadVoiceMemo, /api/chat) the Workspace already uses — one real
// conversation, two presentations — while J4Room.tsx's own client-side
// send/streaming orchestration is a genuinely separate implementation
// (Sean's explicit call, 2026-08-08: don't touch/refactor the shipped
// J4Workspace.tsx to get there; a little client-side duplication is the
// honest trade-off for not risking the working Workspace file).
export default async function J4RoomPage() {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  // AMBIGUOUS IS NOT "NO BUSINESS" (2026-08-21). resolveUserStore returns null
  // for both, so an account reaching two businesses with nothing saying which
  // was sent to /onboarding — told to create a business when it has several.
  const resolution = await resolveBusiness(session.user.id);
  if (resolution.kind === "ambiguous") {
    redirect("/choose-business");
  }
  if (resolution.kind === "none") {
    // No real store yet — same real gap /j4/page.tsx already handles.
    redirect("/onboarding");
  }
  const { store, role } = resolution;
  if (!hasPermission(role, PERMISSIONS.GENESIS_CHAT)) {
    redirect("/dashboard");
  }

  // Same bounded window /j4/page.tsx and app/api/chat/route.ts already use
  // for the same real reason — kept in sync deliberately, not by
  // coincidence.
  const CHAT_HISTORY_WINDOW = 50;
  const [recentMessages, pendingApprovals] = await Promise.all([
    prisma.storeMessage.findMany({
      where: { storeId: store.id },
      orderBy: { createdAt: "desc" },
      take: CHAT_HISTORY_WINDOW,
    }),
    // Phase 1's own "displaying the reusable information we already have
    // available" (Sean) — a quiet, ambient reference to decisions already
    // waiting in the Workspace, not a duplicate approval UI inside Room.
    // Same permission gate /j4/page.tsx already uses for this same data.
    hasPermission(role, PERMISSIONS.ANALYTICS_VIEW) ? getPendingApprovals(store.id) : Promise.resolve([]),
  ]);
  const messages = recentMessages.reverse();

  return (
    <J4Room
      messages={messages.map((m) => ({ id: m.id, role: m.role, content: m.content, changes: m.changes }))}
      sendMessage={sendStoreMessage}
      uploadVoiceMemo={uploadVoiceMemo}
      pendingDecisionsCount={pendingApprovals.length}
    />
  );
}
