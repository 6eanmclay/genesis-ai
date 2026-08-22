import Link from "next/link";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { formatMoney } from "@/lib/money";
import { SubmitButton } from "./SubmitButton";
import { GenesisAssistant } from "./GenesisAssistant";
import { CreateStoreForm } from "./CreateStoreForm";
import { ReviewBusinessButton } from "./ReviewBusinessButton";
import {
  updateStoreDraft,
  discardStoreDraft,
  sendDraftMessage,
  applyThemePersonality,
  restoreStoreDraftVersion,
  confirmStoreDraft,
  approveGenesisAction,
  rejectGenesisAction,
  approveGenesisActionGroup,
  startIssueConversation,
  startDiscoveryConversation,
  startTaskConversation,
  answerEconomicsQuestionFromCard,
  dismissAttentionCard,
} from "./ai-actions";
import { getNextBestAction } from "@/lib/intelligence/nextBestAction";
import { DEFAULT_THEME, googleFontsUrl, themeCssVars, type Theme } from "@/lib/theme";
import type { OnboardingState } from "@/lib/onboarding/types";
import type { Store, StoreRole } from "@prisma/client";
import { PERMISSIONS, hasPermission, type Permission } from "@/lib/permissions";
import { getOrderSummary, getRecentActivity, getRecentOrders } from "@/lib/dashboard/whatHappened";
import { getAttentionItems } from "@/lib/dashboard/needsAttention";
import { getDiscoveryFeed, getLastDiscoveryRunAt } from "@/lib/dashboard/discovery";
import { getInventorySnapshot } from "@/lib/dashboard/inventory";
import { getPendingApprovals } from "@/lib/dashboard/pendingApprovals";
import { runOpportunisticAiReviewIfStale } from "@/lib/dashboard/genesisObservations";
import { measureDueMeasurements } from "@/lib/dashboard/postExecutionMeasurement";
import { runTaskDetection } from "@/lib/dashboard/taskDetectors";
import { getOpenTasks } from "@/lib/dashboard/tasks";
import { ActivityFeed } from "./ActivityFeed";
import { AttentionCardList } from "./AttentionCardList";
import { J4NoticedDisclosure } from "./J4NoticedDisclosure";
import { buildAttentionCards, getDismissedCardIds } from "@/lib/dashboard/attentionCards";
import { RecentOrdersCard } from "./RecentOrdersCard";
import { BusinessJourney } from "./BusinessJourney";
import { logJourneyStageIfChanged } from "@/lib/dashboard/journeyStage";

const BRAND_PERSONALITIES = [
  "Luxury",
  "Modern",
  "Professional",
  "Friendly",
  "Heritage",
  "Bold",
  "Minimal",
  "Organic",
] as const;

type DraftProduct = {
  name: string;
  description: string;
  price: number;
};

// Small relative-time formatter for "Generated X ago" — this codebase has
// no existing time-ago utility (elsewhere just uses toLocaleString()), and
// pulling in a date library for one label wasn't worth it.
function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

// A subtle accent-tinted header for the workspace, plus a monogram avatar
// and accent-colored primary buttons — this is intentionally lighter-touch
// than the full theme applied on the public storefront. Body text, form
// inputs, and card backgrounds stay neutral so the workspace stays
// readable no matter what palette Genesis generates.
function BrandHeader({
  theme,
  name,
  eyebrow,
}: {
  theme: Theme;
  name: string;
  eyebrow?: string;
}) {
  const fontsUrl = googleFontsUrl([theme.typography.headingFont]);
  return (
    <>
      {fontsUrl && <link rel="stylesheet" href={fontsUrl} />}
      <div
        className="flex items-center gap-3 rounded-2xl bg-gradient-to-r from-[var(--brand-primary)]/10 via-[var(--brand-accent)]/10 to-transparent p-4"
      >
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--brand-accent)] text-lg font-semibold text-white">
          {name.trim().charAt(0).toUpperCase() || "?"}
        </div>
        <div>
          {eyebrow && (
            <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
              {eyebrow}
            </p>
          )}
          <p className="font-[var(--font-heading)] text-2xl font-semibold text-black dark:text-zinc-50">
            {name}
          </p>
        </div>
      </div>
    </>
  );
}

// Padding/text-size are deliberately excluded so every call site sets its
// own — Tailwind class order doesn't reliably resolve conflicting utilities
// (e.g. px-5 from here vs px-4 at the call site), so this only ever
// contains non-conflicting brand styling.
const ACCENT_BUTTON =
  "rounded-full bg-[var(--brand-accent)] text-white transition hover:opacity-90 disabled:opacity-50";

// Home, for ONE business (2026-08-20, BUSINESS_CONTEXT.md Phase A).
//
// Extracted from the page so both routes render the same screen. What did NOT
// come with it is the branch above it: the page used to open by asking whether
// this account has a business at all, and if not, render onboarding. Under
// /b/[slug] that question is already answered \u2014 a business was named in the URL
// and access to it was verified \u2014 so the branch is unreachable there by
// construction rather than by a check.
//
// That is why this was a split rather than a move. The onboarding half belongs
// to the account; this half belongs to a business.

export interface HomeWorkspaceProps {
  store: Store;
  role: StoreRole;
  userId: string;
  userName: string | null;
  /** The account's analytics session, threaded rather than re-read. */
  sessionInstanceId: string | undefined;
  basePath: string;
  slug?: string;
}

export async function HomeWorkspace({
  store,
  role,
  userId,
  userName,
  sessionInstanceId,
  basePath,
  slug,
}: HomeWorkspaceProps) {

  // Phase 4 — the opportunistic, cost-gated AI review trigger. Scheduled
  // via after() so an unlucky page load that happens to be stale never
  // blocks or slows this render — it only runs once the response has
  // already been sent. runOpportunisticAiReviewIfStale does its own
  // staleness/claim check first and is usually a no-op.
  // Daily Operating Rhythm — the real, only trigger for the composed
  // "briefing" narrative: owner-only (see genesisBriefingComposer.ts's own
  // comment on why this isn't personalized per employee yet), and only ever
  // from this real, attended page load — never the scheduler's cron pass.
  after(() =>
    runOpportunisticAiReviewIfStale(
      store.id,
      userId,
      undefined,
      role === "OWNER" ? userId : undefined
    ).catch(() => {})
  );
  // Phase 5 — a separate after() call, deliberately not bundled into the
  // AI-review gate above: measurement is deterministic/zero-AI-cost and
  // should run on every opportunistic trigger, not only when the (unrelated)
  // AI-review staleness check happens to fire.
  after(() => measureDueMeasurements(store.id).catch(() => {}));
  // P0.5 sourcing MOVED TO THE SCHEDULER (2026-08-21, BI milestone).
  //
  // Discovery and the supplier-economics refresh used to run from here, on an
  // after(). That was the right home while there was no unattended path, and it
  // had one real limitation: a business whose owner never opened Home was never
  // searched and never refreshed.
  //
  // Both now run as a stage of the existing CRON_SECRET-gated route
  // (lib/sourcing/sourcingSchedule.ts). Deliberately not BOTH: two callers would
  // mean the same supplier HTTP calls fired twice for an owner who happens to be
  // looking at Home when the cron runs, and the cost boundary would have two
  // places to reason about instead of one. The owner's own "Look again" on the
  // catalog is still there for anybody who does not want to wait.

  const products = await prisma.product.findMany({
    where: { storeId: store.id },
    select: { active: true },
  });

  const [stripeIntegration, paypalIntegration] =
    role === "OWNER"
      ? await Promise.all([
          prisma.storeIntegration.findUnique({
            where: { storeId_provider: { storeId: store.id, provider: "STRIPE" } },
            select: { status: true },
          }),
          prisma.storeIntegration.findUnique({
            where: { storeId_provider: { storeId: store.id, provider: "PAYPAL" } },
            select: { status: true },
          }),
        ])
      : [null, null];

  const can = (permission: Permission) => (role ? hasPermission(role, permission) : false);
  const canViewOrders = can(PERMISSIONS.ORDERS_VIEW);
  const canViewRevenue = can(PERMISSIONS.REVENUE_VIEW);
  const canViewAnalytics = can(PERMISSIONS.ANALYTICS_VIEW);
  // Activity Feed / Attention Panel mix in action types (Stripe changes,
  // store renames) an Employee doesn't have visibility into anywhere else
  // on the dashboard today — Owner-only for now, not architecturally
  // permanent (see ARCHITECTURE.md).
  const isOwnerManager = role === "OWNER";

  const [orderSummary, recentOrders, activityItems, attention] = await Promise.all([
    canViewOrders ? getOrderSummary(store.id, { includeRevenue: canViewRevenue }) : Promise.resolve(null),
    canViewOrders
      ? getRecentOrders(store.id, { includeRevenue: canViewRevenue, limit: 5 })
      : Promise.resolve([]),
    // Home shows only the highest-signal recent activity — a full,
    // undifferentiated log isn't what "concise command center" means.
    isOwnerManager ? getRecentActivity(store.id, 5) : Promise.resolve([]),
    isOwnerManager
      ? getAttentionItems(store.id, {
          store: { published: store.published },
          products,
          stripeIntegration,
          paypalIntegration,
        })
      : Promise.resolve({ recentOutcomes: [], currentState: [] }),
  ]);

  const inventorySnapshot = canViewOrders ? getInventorySnapshot(products) : null;

  // Family-beta instrumentation (v20) — same gate BusinessJourney itself
  // renders under, reusing its exact stage logic (lib/dashboard/
  // journeyStage.ts) rather than a second computation. Scheduled via
  // after() so it never adds latency to this page load; a no-op unless the
  // stage genuinely changed since the last time this ran.
  if (isOwnerManager && canViewOrders && orderSummary) {
    after(() =>
      // Empty rather than undefined: the journey log takes a session id, and an
      // account without one is a real state (a page load outside a tracked
      // session) rather than a reason to skip the log.
      logJourneyStageIfChanged(userId, store.id, sessionInstanceId ?? "", {
        published: store.published,
        hasActiveProducts: (inventorySnapshot?.activeCount ?? 0) > 0,
        stripeIntegration,
        paypalIntegration,
        allTimeOrderCount: orderSummary.allTimeOrderCount,
      }).catch(() => {})
    );
  }

  // BUSINESS_ASSETS_ARCHITECTURE.md M1 — awaited, not after(), unlike the
  // journey-stage logger above: that call is pure instrumentation that
  // doesn't affect this render, while task detection has to be visible on
  // THIS page load for the J4 Noticed zone below to render real, current
  // task cards rather than lagging one view behind.
  if (isOwnerManager) {
    await runTaskDetection(store.id, {
      hasActiveProducts: (inventorySnapshot?.activeCount ?? 0) > 0,
      logoUrl: store.logoUrl,
      blueprint: store.blueprint,
    });
  }
  const openTasks = isOwnerManager ? await getOpenTasks(store.id) : [];
  const [discoveryItems, lastDiscoveryRunAt, pendingApprovals, nextRecommendation, dismissedCardIds] = canViewAnalytics
    ? await Promise.all([
        getDiscoveryFeed(store.id),
        getLastDiscoveryRunAt(store.id),
        getPendingApprovals(store.id),
        // Growth Engine M3 — refresh: false, zero new AI calls on every
        // Home load. Freshness comes from M1 (Learn now runs on every
        // scheduler pass, not gated behind the 24h review) and M2 (real
        // track-record-informed confidence) already keeping the
        // underlying state genuinely current.
        getNextBestAction(store.id, userId, { refresh: false }),
        getDismissedCardIds(store.id),
      ])
    : [[], null, [], null, new Set<string>()];

  const storeTheme = (store.theme as Theme | null) ?? DEFAULT_THEME;
  const fontsUrl = googleFontsUrl([storeTheme.typography.headingFont]);

  // Home Redesign (2026-08-08) — "the dashboard shows the business, J4
  // handles the work" (Sean). Previously four independently-designed
  // sections (NextRecommendation, AttentionPanel+ApprovalsSummary,
  // DiscoveryFeed, TaskCards) competed for the same real estate with four
  // different visual languages, all really answering one question: "does
  // this business need me right now?" buildAttentionCards normalizes all
  // four real sources into one shared, capped, prioritized card list — see
  // lib/dashboard/attentionCards.ts for the full reasoning. Every input
  // here is already permission-gated at the fetch site above (empty/null
  // when the role doesn't have access), so this needs no extra permission
  // branching of its own.
  const attentionCards = buildAttentionCards({
    basePath,
    issues: attention.recentOutcomes,
    pendingApprovals,
    nextRecommendation,
    discoveryItems,
    tasks: openTasks.map((t) => ({
      id: t.id,
      title: t.title,
      summary: t.summary,
      // Carried so a supplier-economics question can render as the form it
      // is rather than a link to a conversation about two numbers.
      source: t.source,
      dedupeKey: t.dedupeKey,
      requiredInput: t.requiredInput,
    })),
    currency: store.currency,
    dismissedCardIds: dismissedCardIds as Set<string>,
  });

  return (
    <div style={themeCssVars(storeTheme)} className="min-h-screen p-8 lg:min-h-0">
      {fontsUrl && <link rel="stylesheet" href={fontsUrl} />}

      {/* Today, at a glance — the workspace now begins directly with real
          business state; the greeting moved to Live Intelligence (see
          GenesisGreeting.tsx/LiveIntelligence.tsx), which already briefs
          the owner by name before they ever reach this page. Large
          numbers, no boxes; spacing and type carry the hierarchy instead
          of bordered cards. */}
      {canViewOrders && orderSummary && (
        <div className="flex flex-wrap items-baseline gap-x-12 gap-y-5">
          {orderSummary.revenueInCents !== null && (
            <div>
              <p className="font-[var(--font-heading)] text-4xl font-semibold text-black dark:text-zinc-50">
                {formatMoney(orderSummary.revenueInCents, store.currency)}
              </p>
              <p className="mt-1 text-xs text-zinc-500">
                {orderSummary.windowLabel.toLowerCase()} revenue
              </p>
            </div>
          )}
          <div>
            <p className="font-[var(--font-heading)] text-4xl font-semibold text-black dark:text-zinc-50">
              {orderSummary.orderCount}
            </p>
            <p className="mt-1 text-xs text-zinc-500">
              order{orderSummary.orderCount === 1 ? "" : "s"}, {orderSummary.windowLabel.toLowerCase()}
            </p>
          </div>
          {inventorySnapshot && (
            <div>
              <p className="font-[var(--font-heading)] text-4xl font-semibold text-black dark:text-zinc-50">
                {inventorySnapshot.activeCount}
              </p>
              <p className="mt-1 text-xs text-zinc-500">active products</p>
            </div>
          )}
          <Link href={`${basePath}/website`} className="group">
            <p
              className={
                store.published
                  ? "font-[var(--font-heading)] text-4xl font-semibold text-emerald-600 dark:text-emerald-400"
                  : "font-[var(--font-heading)] text-4xl font-semibold text-zinc-400 dark:text-zinc-600"
              }
            >
              {store.published ? "Live" : "Unpublished"}
            </p>
            <p className="mt-1 text-xs text-zinc-500 group-hover:underline">
              storefront
            </p>
          </Link>
        </div>
      )}

      {/* J4 Noticed — Home Redesign (2026-08-08): one compact, capped,
          prioritized zone replacing four separately-designed sections
          (see attentionCards's own comment above). Rendered directly under
          Snapshot, before Business Journey, so a genuine owner-action state
          is visible in the initial viewport without scrolling — same
          positioning reasoning the old "Needs your attention" section
          already established, just for the unified list. The review
          control moves here from Discovery's old header — it's the same
          "how current is what J4 noticed" question, now asked in one place
          instead of two. */}
      {(isOwnerManager || canViewAnalytics) && (
        <>
          {/* Header is desktop-only now — on mobile J4NoticedDisclosure's own
              row is the heading, the count, and the control all at once. */}
          <div className="mt-10 hidden flex-wrap items-center justify-between gap-3 md:flex">
            <h2 id="attention" className="text-lg font-semibold text-black dark:text-zinc-50">
              J4 Noticed
            </h2>
            {canViewAnalytics && (
              <div className="flex items-center gap-3">
                <span className="text-xs text-zinc-500">
                  {lastDiscoveryRunAt
                    ? `Reviewed ${formatTimeAgo(lastDiscoveryRunAt)}`
                    : "J4 hasn't reviewed this business yet"}
                </span>
                <ReviewBusinessButton className="rounded-full border border-black/[.08] px-3 py-1.5 text-xs text-zinc-600 transition-colors hover:bg-black/[.03] disabled:opacity-50 dark:border-white/[.145] dark:text-zinc-300 dark:hover:bg-white/[.05]" />
              </div>
            )}
          </div>
          {attentionCards.cards.length === 0 ? (
            <div className="mt-3 max-w-2xl rounded-2xl border border-[#2563eb]/15 bg-[#2563eb]/[0.035] px-5 py-4">
              <p className="text-sm text-zinc-700 dark:text-zinc-300">
                Nothing needs you right now — I&apos;m still watching {store.name}.
              </p>
              <p className="mt-1 text-xs text-zinc-500">J4 never stops working on your business.</p>
            </div>
          ) : (
            <J4NoticedDisclosure count={attentionCards.cards.length + attentionCards.overflowCount}>
              <div className="mt-3">
                <AttentionCardList
                  cards={attentionCards.cards}
                  approveAction={approveGenesisAction}
                  rejectAction={rejectGenesisAction}
                  approveGroupAction={approveGenesisActionGroup}
                  issueAction={startIssueConversation}
                  discoveryAction={startDiscoveryConversation}
                  taskAction={startTaskConversation}
                  economicsAction={answerEconomicsQuestionFromCard}
                  dismissAction={dismissAttentionCard}
                  currentPath="/dashboard"
                />
                {attentionCards.overflowCount > 0 && (
                  <p className="mt-1 text-xs text-zinc-500">
                    +{attentionCards.overflowCount} more — ask J4 what else he&apos;s noticed.
                  </p>
                )}
              </div>
            </J4NoticedDisclosure>
          )}
        </>
      )}

      {/* Business Journey — real progress, not a software setup checklist. */}
      {isOwnerManager && canViewOrders && orderSummary && (
        <BusinessJourney
          basePath={basePath}
          published={store.published}
          hasActiveProducts={(inventorySnapshot?.activeCount ?? 0) > 0}
          stripeIntegration={stripeIntegration}
          paypalIntegration={paypalIntegration}
          allTimeOrderCount={orderSummary.allTimeOrderCount}
        />
      )}

      {/* Recent orders — positive activity, shown separately from anything problem-shaped */}
      {canViewOrders && recentOrders.length > 0 && (
        <>
          <h2 className="mt-10 text-lg font-semibold text-black dark:text-zinc-50">
            Recent orders
          </h2>
          <RecentOrdersCard orders={recentOrders} basePath={basePath} />
        </>
      )}

      {/* Recently — compact, human-readable, absent entirely when there's nothing */}
      {isOwnerManager && activityItems.length > 0 && (
        <>
          <h2 className="mt-10 text-lg font-semibold text-black dark:text-zinc-50">
            Recently
          </h2>
          <div className="mt-3 max-w-md">
            <ActivityFeed items={activityItems} />
          </div>
        </>
      )}
    </div>
  );
}
