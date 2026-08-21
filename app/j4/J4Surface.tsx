import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { PERMISSIONS, hasPermission, resolveUserStore } from "@/lib/permissions";
import { accessTo } from "@/lib/businessContext";
import { getPendingApprovals } from "@/lib/dashboard/pendingApprovals";
import { getOpenTasks } from "@/lib/dashboard/tasks";
import { ACTION_SECTIONS } from "@/lib/execution/genesisActions";
import { sendStoreMessage, uploadBusinessAssetFromChat, uploadPhotoBatchFromChat, uploadVoiceMemo } from "@/app/dashboard/ai-actions";
import { getBusinessUnderstanding, type BusinessUnderstanding } from "@/lib/businessModel/understanding";
import { J4Workspace, type J4Surface as J4SurfaceKind, type UnderstandingGroup } from "./J4Workspace";
import { J4Proposal } from "./J4Proposal";
import { getOpenProposals } from "@/lib/storefront/proposals";
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
function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(value: string | Date): string {
  return new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function trendArrow(direction: "up" | "down" | "flat" | undefined): string {
  return direction === "up" ? "↑" : direction === "down" ? "↓" : "—";
}

// What J4 understands, flattened into headings and plain lines for the Office
// (2026-08-16).
//
// This is the same material as /dashboard/understanding and reads from the
// same getBusinessUnderstanding() call, deliberately: there is one answer to
// "what does J4 know," and a second assembly of the same facts would be free
// to drift from it. The page keeps the full version with its links out to
// brand, catalog, customers and connections; this is that picture read as a
// briefing, inside the Office where the rest of J4's material already lives.
//
// Every group is returned even when it is empty, and each carries its own
// sentence for that case. "I don't know your suppliers yet" is real
// information about the state of J4's understanding — dropping empty groups
// would quietly overstate how much it knows.
function toUnderstandingGroups(u: BusinessUnderstanding): UnderstandingGroup[] {
  const { profile, beliefs, recentDecisions, activeThoughts, platformRelationship, currentAssets } = u;

  const identity: string[] = [];
  identity.push(profile.identity.tagline ? `${profile.identity.name} — ${profile.identity.tagline}` : profile.identity.name);
  if (profile.identity.description) identity.push(profile.identity.description);
  const classification = [
    ...profile.classification.businessCategories.map((c) => c.label),
    ...profile.classification.revenueStreams.map((r) => r.label),
  ];
  if (classification.length > 0) identity.push(classification.join(" · "));

  const offerings: string[] = [
    `${profile.offerings.activeCount} active product${profile.offerings.activeCount === 1 ? "" : "s"}`,
    ...profile.offerings.trends
      .filter((t) => t.trend !== null)
      .slice(0, 3)
      .map((t) => `${trendArrow(t.trend?.direction)} ${t.item.data.name} — ${Math.round((t.trend?.changeRatio ?? 0) * 100)}%`),
  ];

  const people: string[] = [];
  if (profile.people.owner) people.push(`${profile.people.owner.name ?? profile.people.owner.email} — Owner`);
  for (const m of profile.people.members) people.push(`${m.name ?? m.email} — ${m.role}`);
  for (const e of profile.people.employees) {
    people.push(`${e.data.name}${e.data.title ? ` — ${e.data.title}` : ""}${e.data.status === "former" ? " (former)" : ""}`);
  }

  const goals: string[] = [
    ...profile.goals.map((g) => `Goal (${g.data.status}) — ${g.data.description}`),
    ...profile.challenges.map((c) => `Challenge (${c.data.status}) — ${c.data.description}`),
  ];

  return [
    { key: "identity", label: "Identity", lines: identity, empty: "I don't have your business identity yet." },
    {
      // What J4 can point at by name. This is the visible proof that a
      // designated asset resolves to a real record rather than a URL on a
      // column — if "brand.logo" appears here, "that logo" has something to
      // mean.
      key: "assets",
      label: "Assets I can use",
      lines: Object.entries(currentAssets).map(
        ([role, asset]) => `${role} — ${asset.summary ?? asset.originalFilename}${asset.origin ? ` (${asset.origin})` : ""}`
      ),
      empty: "Nothing designated yet. Generated and uploaded files become usable assets once they have a role.",
    },
    { key: "offerings", label: "What you sell", lines: offerings, empty: "Nothing in the catalog yet." },
    {
      key: "revenue",
      label: "Revenue",
      lines: [
        `Last 30 days — ${formatCents(profile.revenue.last30DaysInCents)}`,
        `All time — ${formatCents(profile.revenue.allTimeInCents)}`,
      ],
      empty: "No revenue recorded yet.",
    },
    {
      key: "customers",
      label: "Customers",
      lines: [
        `${profile.customers.totalContactCount} known contact${profile.customers.totalContactCount === 1 ? "" : "s"}`,
        `Repeat ${profile.customers.segments.repeatCustomers.length} ${trendArrow(profile.customers.segmentTrends.repeatCustomers?.direction)} · ` +
          `High-value ${profile.customers.segments.highValueCustomers.length} ${trendArrow(profile.customers.segmentTrends.highValueCustomers?.direction)} · ` +
          `Lapsed ${profile.customers.segments.lapsedCustomers.length} ${trendArrow(profile.customers.segmentTrends.lapsedCustomers?.direction)} · ` +
          `New ${profile.customers.segments.newCustomers.length} ${trendArrow(profile.customers.segmentTrends.newCustomers?.direction)}`,
      ],
      empty: "No customers yet.",
    },
    { key: "people", label: "People", lines: people, empty: "Just you so far." },
    {
      key: "suppliers",
      label: "Suppliers",
      lines: profile.suppliers.map((s) => `${s.data.name}${s.data.email ? ` — ${s.data.email}` : ""}`),
      empty: "None known yet. Mention one in conversation and I'll remember it.",
    },
    {
      key: "locations",
      label: "Locations",
      lines: profile.locations.map(
        (l) => `${l.data.name}${l.data.city ? ` — ${l.data.city}${l.data.state ? `, ${l.data.state}` : ""}` : ""}`
      ),
      empty: "None known yet.",
    },
    { key: "goals", label: "Goals and challenges", lines: goals, empty: "Nothing stated yet. Tell me a goal and I'll hold onto it." },
    {
      key: "assets",
      label: "Business assets",
      lines: profile.assets.map(
        (a) =>
          `${a.data.originalFilename}${a.data.category === "unclassified" ? " — not yet reviewed" : ` — ${a.data.category.replace(/_/g, " ")}`}` +
          `${a.data.summary ? `: ${a.data.summary}` : ""}`
      ),
      empty: "Nothing uploaded yet.",
    },
    {
      key: "systems",
      label: "Connected systems",
      lines: profile.connectedSystems.map(
        (s) => `${s.displayName} — ${s.status}${s.syncedAgoLabel ? ` — synced ${s.syncedAgoLabel}${s.isStale ? " (stale)" : ""}` : ""}`
      ),
      empty: "Nothing connected yet.",
    },
    {
      key: "beliefs",
      label: "What I've learned",
      lines: beliefs.map((b) => `${b.claim} — ${Math.round(b.confidence * 100)}% confidence, ${b.maturity.replace(/_/g, " ")}`),
      empty: "Nothing yet. Beliefs form once a real pattern repeats.",
    },
    {
      key: "decisions",
      label: "Recent decisions",
      lines: recentDecisions.map((d) => `${d.decision === "executed" ? "✓" : "✕"} ${d.summary} — ${formatDate(d.decidedAt)}`),
      empty: "Nothing in the last two weeks.",
    },
    {
      key: "open",
      label: "Still open",
      lines: activeThoughts.slice(0, 5).map((t) => t.summary),
      empty: "Nothing open right now.",
    },
    {
      key: "platform",
      label: "Your relationship with Genesis",
      lines: [
        `${platformRelationship.planName ?? "No plan"} — ${platformRelationship.growthPointBalance} Growth Points`,
        ...(platformRelationship.subscriptionStatus ? [platformRelationship.subscriptionStatus] : []),
        ...(platformRelationship.businessPartnerTrialEndsAt
          ? [`Business Partner trial ends ${formatDate(platformRelationship.businessPartnerTrialEndsAt)}`]
          : []),
      ],
      empty: "No plan yet.",
    },
  ];
}

// A REAL CROSS-BUSINESS LEAK, found by the browser session (2026-08-20).
//
// This surface is rendered by the workspace shell, so it appears on every screen
// — including every screen under /b/[slug]. It resolved the account's ACTIVE
// business rather than the one being viewed, so J4's tasks, ideas, decisions and
// information for one business were rendered on another business's pages.
//
// Nothing in the database was wrong and no authorization was bypassed; the rows
// were correctly scoped to the business they belonged to. This read the wrong
// business, which is the same class of defect and just as visible to an owner:
// they open Copper & Coil and J4 talks to them about Iron Gym.
//
// Not caught by any suite, because every suite asserts on resolution and
// authorization. It took a real browser rendering a real page to see it — which
// is the argument for the browser session, made by the browser session.
export async function J4Surface({ surface, slug }: { surface: J4SurfaceKind; slug?: string }) {
  // `isRoom` used to live here and gated the Tasks read. Both surfaces now
  // fetch the same material, because both surfaces show it — see the Promise
  // .all below. Deleted rather than left unused: a ready-made "the layer is
  // the lesser surface" flag is what the last two bugs were built on.

  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  // The business this surface was rendered inside, when there is one. Falls back
  // to the account's active business only on the legacy route, which has no slug
  // to be told about.
  const resolved = slug
    ? await accessTo(session.user.id, (await prisma.store.findUnique({ where: { slug }, select: { id: true } }))?.id ?? "")
        .then((a) => (a ? { store: a.store, role: a.role } : null))
    : await resolveUserStore(session.user.id);
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
  const [recentMessages, observations, explanations, pendingApprovals, openTasks, understanding] = await Promise.all([
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
    // BOTH SURFACES NOW (2026-08-16). This was `isRoom ? … : []`, on the
    // sound reasoning that Tasks appeared nowhere in the layer, so the layer
    // should not pay for a read it would never show.
    //
    // The Office consolidation made that a bug. The layer IS the Office, and
    // the Office shows Tasks — so the gate meant the Tasks view rendered its
    // empty state no matter how many open tasks a store had. Exactly the
    // shape of bug the category rail had: the surface was updated and one
    // upstream line still assumed the old split. Same permission tier as
    // observations and explanations: a Task is operational work, not
    // financial data.
    getOpenTasks(store.id),
    // What J4 understands, for the Office's Understanding view. store:manage
    // matching /dashboard/understanding, which has always required it — a
    // role without it gets no groups and the view says so, rather than a
    // half-populated picture.
    //
    // COST, honestly: this is the heaviest read here, and the layer renders on
    // every dashboard page. It sits inside this Promise.all rather than after
    // it, so it runs concurrently with the five reads already happening and
    // getBusinessUnderstanding parallelises internally too — the added
    // wall-clock is the amount by which its slowest query exceeds the current
    // slowest, not the sum of its parts. If navigation ever feels slower, the
    // fix is to stream this view rather than to put it back behind a gate:
    // a gate is what produced the Tasks bug directly above.
    hasPermission(role, PERMISSIONS.STORE_MANAGE)
      ? getBusinessUnderstanding(store.id)
      : Promise.resolve(null),
  ]);

  // THE proposal on the table — one, never a stack (2026-08-14).
  //
  // Sean: "there must only be ONE J4 conversation." Several proposal cards
  // above one composer read as several parallel threads, which is exactly the
  // fragmentation being ruled out. So this shows the one currently under
  // discussion (newest first) and says plainly that others are waiting rather
  // than rendering them as competing conversations.
  //
  // BOTH SURFACES, corrected 2026-08-14. This was layer-only for one build,
  // on the reasoning that the layer is where proposals belong. That was wrong,
  // and Sean caught it from a screenshot: the room shows the SAME conversation,
  // so a proposal raised while the owner is reading it there simply never
  // appeared, and the decision was unreachable from the very place the
  // discussion was happening. A proposal belongs to the CONVERSATION, and the
  // conversation is on both surfaces. See GENESIS_SURFACES.md decision 4.
  const openProposals = await getOpenProposals(store.id);
  const proposalOnTable = openProposals[0] ?? null;
  const otherPendingCount = Math.max(0, openProposals.length - 1);
  const storefrontUrl = proposalOnTable ? `${await getBaseUrl()}/store/${store.slug}` : null;

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
      slug={slug}
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
      understanding={understanding ? toUnderstandingGroups(understanding) : []}
      // Rendered on the server and handed down, so the layer stays a client
      // component without needing to fetch or know about proposals itself.
      proposal={
        proposalOnTable && storefrontUrl ? (
          <J4Proposal
            proposal={proposalOnTable}
            storefrontUrl={storefrontUrl}
            storeName={store.name}
            otherPendingCount={otherPendingCount}
          />
        ) : null
      }
    />
  );
}
