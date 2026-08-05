import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { PERMISSIONS, hasPermission, resolveUserStore } from "@/lib/permissions";
import { NAV_SECTIONS, YOUR_BUSINESS_SECTIONS } from "@/lib/dashboard/navConfig";
import { getPendingApprovals } from "@/lib/dashboard/pendingApprovals";
import { getOrderSummary, getRevenueTrend } from "@/lib/dashboard/whatHappened";
import { getNewCustomerCount } from "@/lib/dashboard/customers";
import { ACTION_SECTIONS } from "@/lib/execution/genesisActions";
import { getBaseUrl } from "@/lib/integrations/util";
import { sendStoreMessage } from "./ai-actions";
import { signOutOfGenesis } from "./actions";
import { DashboardShell } from "./DashboardShell";

// Two entirely different chrome states share this one layout: a user with
// no live store yet (still in the draft/onboarding wizard, page.tsx's own
// two early-return branches) gets just the minimal sign-out chrome it
// always had — the wizard is a linear flow, not a nav destination, so it
// stays outside the section shell. A user with a live store gets the full
// multi-section app shell. Both branches re-check auth/resolve the store
// themselves rather than threading data down, matching this codebase's
// existing per-component-fetches-its-own-data convention.
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  const resolved = await resolveUserStore(session.user.id);

  if (!resolved) {
    return (
      <div className="relative">
        <form action={signOutOfGenesis} className="fixed top-3 right-3 z-50">
          <button
            type="submit"
            className="rounded-full border border-black/[.08] bg-white/90 px-3 py-1.5 text-xs font-medium text-zinc-600 shadow-sm backdrop-blur transition-colors hover:bg-white dark:border-white/[.145] dark:bg-zinc-900/90 dark:text-zinc-300 dark:hover:bg-zinc-900"
          >
            Sign out
          </button>
        </form>
        {children}
      </div>
    );
  }

  const { store, role } = resolved;
  // Filtering by real hasPermission belongs here, not in navConfig.ts —
  // that file is imported directly by the client-side DashboardShell, and
  // a value import of hasPermission would drag lib/permissions.ts's
  // prisma dependency into the browser bundle.
  const sections = NAV_SECTIONS.filter(
    (section) => !section.permission || hasPermission(role, section.permission)
  );
  const secondarySections = YOUR_BUSINESS_SECTIONS.filter(
    (section) => !section.permission || hasPermission(role, section.permission)
  );

  // Live Intelligence's Business Pulse widget — same permission pattern
  // Home already uses (app/dashboard/page.tsx): revenue is never fetched at
  // all for a caller without REVENUE_VIEW, not just hidden in the UI.
  const canViewOrders = hasPermission(role, PERMISSIONS.ORDERS_VIEW);
  const canViewRevenue = hasPermission(role, PERMISSIONS.REVENUE_VIEW);

  const [
    storeMessages,
    pendingApprovals,
    activeObservations,
    activeExplanations,
    orderSummary,
    revenueTrend,
    newCustomerCount,
    activeOwnerBriefing,
  ] = await Promise.all([
    prisma.storeMessage.findMany({ where: { storeId: store.id }, orderBy: { createdAt: "asc" } }),
    hasPermission(role, PERMISSIONS.ANALYTICS_VIEW) ? getPendingApprovals(store.id) : Promise.resolve([]),
    // Phase 4 — the real, deduplicated Purple/Red signals. A cheap, indexed
    // read (same status/storeId index every other approval query already
    // uses the shape of) — never an AI call. dedupeKey/summary added for the
    // contextual connection layer: joins an ApprovalRequest back to the
    // GenesisObservation that noticed the underlying issue, via topicKey.
    prisma.genesisObservation.findMany({
      where: { storeId: store.id, status: "ACTIVE" },
      select: { genesisState: true, dedupeKey: true, summary: true, actionHref: true },
    }),
    // Genesis Language v2 — the real Curiosity signal (see memory
    // project_genesis_language_model.md). Explanation-kind CognitiveOutput
    // rows carry no actionHref (never a destination), so this can only ever
    // feed the global/ambient surfaces — never a per-section nav badge.
    prisma.cognitiveOutput.findMany({
      where: { storeId: store.id, kind: "explanation", status: "ACTIVE" },
      select: { id: true, summary: true },
    }),
    canViewOrders ? getOrderSummary(store.id, { includeRevenue: canViewRevenue }) : Promise.resolve(null),
    // Revenue trend/New Customers — same permission tiers as the flat
    // revenue/order figures above (see getRevenueTrend/getNewCustomerCount
    // for why each is gated the way it is).
    canViewRevenue ? getRevenueTrend(store.id, 30) : Promise.resolve(null),
    canViewOrders ? getNewCustomerCount(store.id, 30) : Promise.resolve(null),
    // Daily Operating Rhythm — owner-only, matches page.tsx's own gating on
    // who the composer ever runs for. A non-owner (or a store before the
    // first composition ever runs) simply gets null, and LiveIntelligence/
    // MobileGenesisPresence already fall back to their existing behavior.
    role === "OWNER"
      ? prisma.cognitiveOutput.findFirst({
          where: { storeId: store.id, kind: "briefing", status: "ACTIVE" },
          select: { summary: true },
        })
      : Promise.resolve(null),
  ]);
  const ownerBriefingSummary = activeOwnerBriefing?.summary ?? null;
  const hasUrgentIssue = activeObservations.some((o) => o.genesisState === "urgent");
  const hasOpportunity = activeObservations.some((o) => o.genesisState === "opportunity");
  const hasCuriosity = activeExplanations.length > 0;
  const curiosityItems = activeExplanations.map((e) => ({ id: e.id, summary: e.summary }));
  const observationSummaryByTopicKey = new Map(activeObservations.map((o) => [o.dedupeKey, o.summary]));

  // The owner/employee can now preview their own storefront whether it's
  // published or not (app/store/[slug]/page.tsx allows owner/employee
  // preview of an unpublished store) — so View Store is always a real,
  // working link, not just once the store goes live.
  const storefrontUrl = `${await getBaseUrl()}/store/${store.slug}`;

  // Each pending approval's real Approve/Reject/Regenerate controls live on
  // its owning section (see ACTION_SECTIONS), so that section's nav item
  // gets the badge — but Home also keeps the total, since "does my business
  // need me?" is Home's whole job even though the decision itself happens
  // elsewhere. Phase 4: counted by distinct (groupId ?? id), not raw row
  // count — one Genesis thought with 3 proposals is one pending decision,
  // not three, everywhere a badge/count is shown.
  const seenGroupsPerSection = new Map<string, Set<string>>();
  const seenGroupsTotal = new Set<string>();
  // For each section, the oldest still-pending approval's id —
  // pendingApprovals is already createdAt-asc, so the first one seen per
  // section key is the oldest.
  const oldestApprovalIdBySection: Record<string, string> = {};
  for (const approval of pendingApprovals) {
    const groupKey = approval.groupId ?? approval.id;
    seenGroupsTotal.add(groupKey);
    const key = ACTION_SECTIONS[approval.actionType]?.key;
    if (key) {
      if (!seenGroupsPerSection.has(key)) seenGroupsPerSection.set(key, new Set());
      seenGroupsPerSection.get(key)!.add(groupKey);
      if (!(key in oldestApprovalIdBySection)) oldestApprovalIdBySection[key] = approval.id;
    }
  }
  // Unchanged meaning: every primary section's own flat (Yellow-only) badge
  // count — Marketing/Payments/etc. via the "More" dropdown (fixed last
  // pass). "home" stays the store-wide total here; the color-aware,
  // Your-Business-scoped replacement for the "Your Business" nav item
  // itself is computed separately below (sectionNavState.home).
  const sectionBadgeCounts: Record<string, number> = { home: seenGroupsTotal.size };
  for (const [key, groupSet] of seenGroupsPerSection) {
    sectionBadgeCounts[key] = groupSet.size;
  }

  // Per-approval context DashboardShell (a client component) needs to
  // resolve a "?focus=" param on its own — it can't read searchParams
  // itself (layouts don't receive them), and pulling ACTION_SECTIONS'
  // definitions (which transitively import prisma-backed Executables) into
  // client code isn't safe, so the section key is resolved here instead.
  const focusableApprovals = pendingApprovals
    .map((approval) => {
      const section = ACTION_SECTIONS[approval.actionType];
      if (!section) return null;
      return {
        id: approval.id,
        section: section.key,
        href: section.href,
        summary: approval.summary,
        noticedSummary: approval.topicKey
          ? observationSummaryByTopicKey.get(approval.topicKey) ?? null
          : null,
      };
    })
    .filter((a): a is NonNullable<typeof a> => a !== null);

  // Genesis Environment shell — Live Intelligence's "noticing" register.
  // Real ACTIVE GenesisObservation rows already fetched above, excluding
  // any whose underlying issue is already represented by a focusableApproval
  // (via topicKey) so the same real issue never appears twice in one feed.
  const coveredTopicKeys = new Set(
    pendingApprovals.map((a) => a.topicKey).filter((k): k is string => k !== null)
  );
  const liveObservations = activeObservations
    .filter((o) => !coveredTopicKeys.has(o.dedupeKey))
    .map((o) => ({
      dedupeKey: o.dedupeKey,
      genesisState: o.genesisState,
      summary: o.summary,
      actionHref: o.actionHref,
    }));

  // Genesis Language propagating through Your Business's own hierarchy —
  // reuses the exact priority order already established in
  // lib/dashboard/genesisState.ts (urgent > needs_decision > opportunity;
  // "working"/Blue has no destination and is correctly never part of
  // this), scoped per real destination rather than store-wide. The reverse
  // lookup is built from YOUR_BUSINESS_SECTIONS itself — not a hand-written
  // table — so it can never silently drift from the real secondary nav.
  // Overview deliberately never "owns" anything: no approval or
  // observation's real destination is ever plain "/dashboard" (confirmed
  // by direct audit of ACTION_SECTIONS and every observation source).
  const sectionKeyByHref = new Map(
    YOUR_BUSINESS_SECTIONS.filter((s) => s.key !== "overview").map((s) => [s.href, s.key])
  );
  const YOUR_BUSINESS_OWNED_KEYS = ["brand", "website", "products"] as const;
  const SECTION_STATE_PRIORITY = { urgent: 0, needs_decision: 1, opportunity: 2, idle: 3 } as const;
  type SectionState = keyof typeof SECTION_STATE_PRIORITY;

  const sectionNavState: Record<string, { state: SectionState; count: number; focusHref: string }> = {};
  for (const key of YOUR_BUSINESS_OWNED_KEYS) {
    const sectionHref = YOUR_BUSINESS_SECTIONS.find((s) => s.key === key)!.href;
    const urgentObs = liveObservations.filter(
      (o) => o.genesisState === "urgent" && o.actionHref && sectionKeyByHref.get(o.actionHref) === key
    );
    const opportunityObs = liveObservations.filter(
      (o) => o.genesisState === "opportunity" && o.actionHref && sectionKeyByHref.get(o.actionHref) === key
    );
    const approvalCount = seenGroupsPerSection.get(key)?.size ?? 0;
    const state: SectionState =
      urgentObs.length > 0
        ? "urgent"
        : approvalCount > 0
          ? "needs_decision"
          : opportunityObs.length > 0
            ? "opportunity"
            : "idle";
    const focusHref =
      state === "urgent"
        ? `${sectionHref}?focus=${urgentObs[0].dedupeKey}`
        : state === "needs_decision"
          ? `${sectionHref}?focus=${oldestApprovalIdBySection[key]}`
          : state === "opportunity"
            ? `${sectionHref}?focus=${opportunityObs[0].dedupeKey}`
            : sectionHref;
    sectionNavState[key] = {
      state,
      count: urgentObs.length + approvalCount + opportunityObs.length,
      focusHref,
    };
  }
  // "Your Business" itself — color = highest-priority state among its own
  // three children; count = their sum. Deliberately scoped to only what
  // Your Business actually owns (unlike sectionBadgeCounts.home above,
  // which stays store-wide) — e.g. a Marketing-only SEO approval is
  // Marketing's own signal (via "More"), not Your Business's.
  const yourBusinessChildren = YOUR_BUSINESS_OWNED_KEYS.map((key) => sectionNavState[key]);
  const yourBusinessState = yourBusinessChildren.reduce((best, s) =>
    SECTION_STATE_PRIORITY[s.state] < SECTION_STATE_PRIORITY[best.state] ? s : best
  );
  sectionNavState.home = {
    state: yourBusinessState.state,
    count: yourBusinessChildren.reduce((sum, s) => sum + s.count, 0),
    focusHref: "/dashboard",
  };

  // Merged focus-target list DashboardShell resolves "?focus=" against —
  // approvals (existing shape, tagged "approval") plus observations that
  // genuinely belong to one of Your Business's own sections (tagged
  // "observation"), so the one mechanism the contextual notification layer
  // already verified extends to Red/Purple instead of becoming a second
  // lookup system.
  const focusableObservations = liveObservations
    .map((o) => {
      const key = o.actionHref ? sectionKeyByHref.get(o.actionHref) : undefined;
      if (!key) return null;
      return {
        kind: "observation" as const,
        id: o.dedupeKey,
        section: key,
        href: o.actionHref!,
        summary: o.summary,
        noticedSummary: null as string | null,
      };
    })
    .filter((o): o is NonNullable<typeof o> => o !== null);
  const focusableItems = [
    ...focusableApprovals.map((a) => ({ ...a, kind: "approval" as const })),
    ...focusableObservations,
  ];

  return (
    <DashboardShell
      sections={sections}
      secondarySections={secondarySections}
      storeId={store.id}
      storeName={store.name}
      storefrontUrl={storefrontUrl}
      logoUrl={store.logoUrl}
      sectionBadgeCounts={sectionBadgeCounts}
      sectionNavState={sectionNavState}
      focusableItems={focusableItems}
      focusableApprovals={focusableApprovals}
      liveObservations={liveObservations}
      curiosityItems={curiosityItems}
      ownerBriefingSummary={ownerBriefingSummary}
      userName={session.user.name ?? null}
      revenueInCents={orderSummary?.revenueInCents ?? null}
      orderCount={orderSummary?.orderCount ?? null}
      revenueTrend={revenueTrend}
      newCustomerCount={newCustomerCount}
      genesisMessages={storeMessages}
      sendGenesisMessage={sendStoreMessage}
      growthPointBalance={store.growthPointBalance}
      // The real Genesis Language signals — Yellow reuses the same grouped
      // count computed above; Purple/Red are real, deduplicated
      // GenesisObservation rows (Phase 4), never faked.
      hasUrgentIssue={hasUrgentIssue}
      hasPendingDecision={seenGroupsTotal.size > 0}
      hasOpportunity={hasOpportunity}
      hasCuriosity={hasCuriosity}
    >
      {children}
    </DashboardShell>
  );
}
