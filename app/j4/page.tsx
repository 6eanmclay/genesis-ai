import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { PERMISSIONS, hasPermission, resolveUserStore } from "@/lib/permissions";
import { getPendingApprovals } from "@/lib/dashboard/pendingApprovals";
import { getOpenTasks } from "@/lib/dashboard/tasks";
import { ACTION_SECTIONS } from "@/lib/execution/genesisActions";
import { sendStoreMessage, uploadBusinessAssetFromChat, uploadPhotoBatchFromChat, uploadVoiceMemo } from "@/app/dashboard/ai-actions";
import { J4Workspace } from "./J4Workspace";

// Reliability hardening — same real evidence as app/dashboard/layout.tsx
// and app/onboarding/meeting/page.tsx: Vercel's real function ceiling is
// 300s (Fluid Compute), not the old assumed 10s. sendStoreMessage calls
// real AI, same durations class as the rest of this app's chat surfaces.
export const maxDuration = 300;

// The J4 Portal, Phase A (2026-08-08) — a real, dedicated route, not a
// shell-level overlay (superseding that earlier decision same day, after
// Sean reconsidered: "you're not opening J4, you're entering J4"). Full
// screen, no dashboard nav underneath — the same "one owner, one device,
// dedicated" placement Meeting with J4 already established
// (app/onboarding/meeting/page.tsx), reused here rather than reinvented.
// The floating GenesisAssistant panel stays exactly as it is for the
// pre-launch draft flow only (app/dashboard/page.tsx) — explicitly
// deprecated for the live-store case this route now replaces.
//
// Naming (Sean, 2026-08-08): "J4 Portal," never "J4 Chat"/"J4 Assistant."
// Dashboard = see/manage the business; the Portal = enter the business
// workspace with J4. Conversation is Phase A's only real capability, but
// the Portal itself is the intended home for whatever comes after it, not
// a name this route will outgrow.
export default async function J4Page() {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  const resolved = await resolveUserStore(session.user.id);
  if (!resolved) {
    // No real store yet — J4 has nothing to work on. Back to onboarding.
    redirect("/onboarding");
  }
  const { store, role } = resolved;
  if (!hasPermission(role, PERMISSIONS.GENESIS_CHAT)) {
    redirect("/dashboard");
  }

  // Same bounded window app/api/chat/route.ts already uses for the same
  // real reason (a store's entire lifetime history was previously fed
  // into every AI call uncapped) — kept in sync deliberately, not by
  // coincidence.
  const CHAT_HISTORY_WINDOW = 50;
  const [recentMessages, observations, explanations, pendingApprovals, openTasks] = await Promise.all([
    prisma.storeMessage.findMany({
      where: { storeId: store.id },
      orderBy: { createdAt: "desc" },
      take: CHAT_HISTORY_WINDOW,
    }),
    // Real Genesis Language rows — see genesisState.ts. Only ever "urgent"
    // or "opportunity" (compareObservationPriority's own comment); this
    // Portal maps opportunity -> Ideas, urgent -> Information (see
    // J4Workspace's own category comment for why).
    prisma.genesisObservation.findMany({
      where: { storeId: store.id, status: "ACTIVE" },
      select: { id: true, genesisState: true, summary: true, actionHref: true },
      orderBy: { firstNoticedAt: "desc" },
    }),
    prisma.cognitiveOutput.findMany({
      where: { storeId: store.id, kind: "explanation", status: "ACTIVE" },
      select: { id: true, summary: true },
      orderBy: { generatedAt: "desc" },
    }),
    hasPermission(role, PERMISSIONS.ANALYTICS_VIEW) ? getPendingApprovals(store.id) : Promise.resolve([]),
    // Same permission tier as observations/explanations above (neither is
    // ANALYTICS_VIEW-gated either) — a Task is operational work, not
    // financial data.
    getOpenTasks(store.id),
  ]);

  const messages = recentMessages.reverse();
  const urgentObservations = observations.filter((o) => o.genesisState === "urgent");
  const ideas = observations.filter((o) => o.genesisState === "opportunity");
  const information = [
    ...urgentObservations.map((o) => ({ id: o.id, summary: o.summary, href: o.actionHref, kind: "urgent" as const })),
    ...explanations.map((e) => ({ id: e.id, summary: e.summary, href: null, kind: "curiosity" as const })),
  ];
  const hasUrgentIssue = urgentObservations.length > 0;
  const hasOpportunity = ideas.length > 0;
  const hasCuriosity = explanations.length > 0;
  const hasPendingDecision = pendingApprovals.length > 0;

  return (
    <J4Workspace
      storeName={store.name}
      messages={messages.map((m) => ({ id: m.id, role: m.role, content: m.content, changes: m.changes }))}
      sendMessage={sendStoreMessage}
      uploadAsset={uploadBusinessAssetFromChat}
      uploadPhotoBatch={uploadPhotoBatchFromChat}
      uploadVoiceMemo={uploadVoiceMemo}
      hasUrgentIssue={hasUrgentIssue}
      hasPendingDecision={hasPendingDecision}
      hasOpportunity={hasOpportunity}
      hasCuriosity={hasCuriosity}
      tasks={openTasks.map((t) => ({ id: t.id, title: t.title, summary: t.summary, href: t.actionHref, priority: t.priority }))}
      decisions={pendingApprovals.map((a) => ({
        id: a.id,
        summary: a.summary,
        createdAt: a.createdAt.toISOString(),
        href: ACTION_SECTIONS[a.actionType]?.href ?? null,
      }))}
      ideas={ideas.map((o) => ({ id: o.id, summary: o.summary, href: o.actionHref }))}
      information={information}
    />
  );
}
