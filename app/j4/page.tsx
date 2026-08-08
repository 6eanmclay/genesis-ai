import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { PERMISSIONS, hasPermission, resolveUserStore } from "@/lib/permissions";
import { getPendingApprovals } from "@/lib/dashboard/pendingApprovals";
import { sendStoreMessage, uploadBusinessAssetFromChat } from "@/app/dashboard/ai-actions";
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
  const [recentMessages, activeObservations, activeExplanations, pendingApprovals] = await Promise.all([
    prisma.storeMessage.findMany({
      where: { storeId: store.id },
      orderBy: { createdAt: "desc" },
      take: CHAT_HISTORY_WINDOW,
    }),
    prisma.genesisObservation.findMany({
      where: { storeId: store.id, status: "ACTIVE" },
      select: { genesisState: true },
    }),
    prisma.cognitiveOutput.findMany({
      where: { storeId: store.id, kind: "explanation", status: "ACTIVE" },
      select: { id: true },
    }),
    hasPermission(role, PERMISSIONS.ANALYTICS_VIEW) ? getPendingApprovals(store.id) : Promise.resolve([]),
  ]);

  const messages = recentMessages.reverse();
  const hasUrgentIssue = activeObservations.some((o) => o.genesisState === "urgent");
  const hasOpportunity = activeObservations.some((o) => o.genesisState === "opportunity");
  const hasCuriosity = activeExplanations.length > 0;
  const hasPendingDecision = pendingApprovals.length > 0;

  return (
    <J4Workspace
      storeName={store.name}
      messages={messages.map((m) => ({ id: m.id, role: m.role, content: m.content, changes: m.changes }))}
      sendMessage={sendStoreMessage}
      uploadAsset={uploadBusinessAssetFromChat}
      hasUrgentIssue={hasUrgentIssue}
      hasPendingDecision={hasPendingDecision}
      hasOpportunity={hasOpportunity}
      hasCuriosity={hasCuriosity}
    />
  );
}
