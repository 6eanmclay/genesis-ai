import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { PERMISSIONS, hasPermission, resolveUserStore } from "@/lib/permissions";
import { getPendingApprovals } from "@/lib/dashboard/pendingApprovals";
import { getOpenTasks } from "@/lib/dashboard/tasks";
import { ACTION_SECTIONS } from "@/lib/execution/genesisActions";
import { sendStoreMessage, uploadBusinessAssetFromChat, uploadPhotoBatchFromChat, uploadVoiceMemo } from "@/app/dashboard/ai-actions";
import { J4Workspace, type J4Surface as J4SurfaceKind } from "./J4Workspace";
import { J4Proposal } from "./J4Proposal";
import { getOpenProposal } from "@/lib/storefront/proposals";
import { getBaseUrl } from "@/lib/integrations/util";

// J4's real conversation, rendered on either of its two surfaces
// (2026-08-14). Extracted from app/j4/page.tsx unchanged so that both the
// persistent layer over the business workspace and the full /j4 room are
// literally the same code reading the same rows — one conversation, one set
// of server actions, one Request → Execute → Verify → Record → Display path.
//
// Sean's clarification, which is what the `surface` prop encodes:
//
//   "The persistent J4 summon is not a shortcut to the J4 page. It is the
//   primary way users converse with J4 while working inside their business."
//
//   "The full J4 page is a deliberate deep work and review destination."
//
// So the layer is conversation, and the room is conversation plus the
// record: Tasks, Ideas, Decisions, Information. The split is honoured here
// too, not only in the markup — the layer does not read what it will not
// show. That matters because the layer is rendered by app/dashboard/
// layout.tsx on every dashboard page, so anything fetched here is fetched on
// every navigation the owner makes.
export async function J4Surface({ surface }: { surface: J4SurfaceKind }) {
  const isRoom = surface === "room";

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
    // or "opportunity" (compareObservationPriority's own comment); the room
    // maps opportunity -> Ideas, urgent -> Information (see J4Workspace's own
    // category comment for why). The layer still needs them: they are what
    // the header's state dot is derived from, so J4 can look concerned
    // without a rail to say why.
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
    // Room only. Tasks appear nowhere in the layer, and this is the one read
    // here that nothing else on a dashboard page already performs — so the
    // layer simply does not make it. Same permission tier as observations/
    // explanations above (neither is ANALYTICS_VIEW-gated either): a Task is
    // operational work, not financial data.
    isRoom ? getOpenTasks(store.id) : Promise.resolve([]),
  ]);

  // The proposal currently on the table, if J4 has made one (2026-08-14).
  // Layer only, and deliberately: a proposal belongs to the conversation that
  // produced it, shown where the owner is standing, never on a page they have
  // to go and find. See GENESIS_SURFACES.md decision 4.
  const openProposal = isRoom ? null : await getOpenProposal(store.id);
  const storefrontUrl = openProposal ? `${await getBaseUrl()}/store/${store.slug}` : null;

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
      surface={surface}
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
      // Rendered on the server and handed down, so the layer stays a client
      // component without needing to fetch or know about proposals itself.
      proposal={
        openProposal && storefrontUrl ? (
          <J4Proposal proposal={openProposal} storefrontUrl={storefrontUrl} storeName={store.name} />
        ) : null
      }
    />
  );
}
