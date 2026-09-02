import { prisma } from "@/lib/prisma";
import { PERMISSIONS, requireBusinessPageOrActive } from "@/lib/permissions";
import { LEGACY_BUSINESS_BASE } from "@/lib/dashboard/navConfig";
import { EXECUTION_ACTIONS } from "@/lib/execution/actions";
import { getBaseUrl } from "@/lib/integrations/util";
import { getPendingApprovals, type PendingApproval } from "@/lib/dashboard/pendingApprovals";
import type { BlueprintContextSubset } from "@/lib/execution/genesisActions";
import { SECTION_LABELS, type SectionKey } from "@/lib/storefrontSections";
import { compareObservationPriority } from "@/lib/dashboard/genesisState";
import { buildPageAttentionCards, getDismissedCardIds } from "@/lib/dashboard/attentionCards";
import { toggleStorePublished } from "../actions";
import {
  approveGenesisAction,
  rejectGenesisAction,
  approveGenesisActionGroup,
  startIssueConversation,
  startDiscoveryConversation,
  startTaskConversation,
  dismissAttentionCard,
} from "../ai-actions";
import { SubmitButton } from "../SubmitButton";
import { VisualProposal } from "../VisualProposal";
import { HeroMock } from "../HeroMock";
import { AttentionCardList } from "../AttentionCardList";
import { FieldValueList } from "../FieldValueList";
import { StringListView } from "../StringListView";
import { FaqListView } from "../FaqListView";
import { DEFAULT_THEME, themeCssVars, type Theme } from "@/lib/theme";

const ACCENT_BUTTON =
  "rounded-full bg-[var(--brand-accent)] text-white transition hover:opacity-90 disabled:opacity-50";

// Supporting text for the section-reorder proposal — the real iframes below
// are the primary evidence, this is just a plain-language recap. Hero is
// shown as a fixed anchor, never as something that moved: it's rendered
// unconditionally first by the storefront (app/store/[slug]/page.tsx's
// renderHero()) and isn't part of sectionOrder at all today.
function formatOrder(order: SectionKey[], customSectionTitle: string | null | undefined): string {
  const labels = order.map((key) =>
    key === "customSection" ? customSectionTitle || "Custom Section" : SECTION_LABELS[key]
  );
  return ["Hero", ...labels].join(" → ");
}

// The live-store home for everything about how the storefront looks,
// reads, and whether customers can see it at all — publish/unpublish and
// storefront visibility live here rather than Settings, which is reserved
// for business/account configuration (see the Home IA cleanup). The
// storefront itself is the page's visual center (embedded live below,
// possible pre-launch too since the storefront route now allows
// owner/employee preview of an unpublished store — see
// app/store/[slug]/page.tsx) — Visibility and Vision History are real,
// preserved, and deliberately secondary rather than competing with it.
// MIGRATED to explicit business context (2026-08-20, BUSINESS_CONTEXT.md Phase
// C). The screen is unchanged. What changed is where it gets its business: a
// `slug` means it was reached at /b/[slug] and that business is authoritative;
// no slug means the legacy /dashboard route, which resolves the account's active
// business exactly as before.
//
// `basePath` is what every link inside uses, so a page rendered for one business
// never links into another.
export async function WebsiteScreen({
  slug,
  basePath,
  searchParams,
}: {
  slug?: string;
  basePath: string;
  searchParams: Promise<{ focus?: string; publish_error?: string }>;
}) {
  const { store } = await requireBusinessPageOrActive(PERMISSIONS.STORE_MANAGE, slug);
  const { publish_error: publishError } = await searchParams;

  // A one-time flash from toggleStorePublished's own redirect — same
  // real-log-message pattern as the Payments page's Stripe/PayPal flash,
  // rather than round-tripping the message through the URL itself.
  const latestPublishLog = publishError
    ? await prisma.executionLog.findFirst({
        where: { storeId: store.id, action: EXECUTION_ACTIONS.STORE_PUBLISH, status: "FAILED" },
        orderBy: { createdAt: "desc" },
      })
    : null;

  const [visions, pendingApprovals, firstProduct, rawObservations, dismissedCardIds] = await Promise.all([
    prisma.storeGeneration.findMany({
      where: { storeId: store.id },
      orderBy: { createdAt: "asc" },
    }),
    getPendingApprovals(store.id),
    prisma.product.findFirst({
      where: { storeId: store.id, active: true },
      orderBy: { position: "asc" },
      select: { imageUrl: true },
    }),
    // Real GenesisObservation rows (Red/Purple) whose own actionHref points
    // directly at this page — the same real data Live Intelligence/the nav
    // badges already use, just filtered to this one destination.
    prisma.genesisObservation.findMany({
      where: { storeId: store.id, status: "ACTIVE", actionHref: "/dashboard/website" },
      select: { dedupeKey: true, genesisState: true, summary: true },
    }),
    getDismissedCardIds(store.id),
  ]);
  const websiteObservations = [...rawObservations].sort(compareObservationPriority);
  const originalVision = visions.find((v) => v.milestone === "original");
  const firstRefinedVision = visions.find((v) => v.milestone === "first_refined");

  // One unified review surface, not three — but each card below stays an
  // independently created, independently decided ApprovalRequest. Proposals
  // sharing a groupId (Phase 4 — one Genesis "thought") get one shared
  // header, but every card underneath keeps its own real Approve/Reject —
  // grouping is presentational only, never a combined decision (see the
  // Phase 3A/4 plans for why that's a real, deliberate limit, not an
  // oversight).
  // Empty on purpose (2026-08-14). These four used to render their proposals
  // at the bottom of this page, and Sean's rule retires that placement:
  // "never put an approval somewhere else just because the underlying target
  // belongs to Website, Products, Identity... the conversation about changing
  // it belongs to the active J4 interaction."
  //
  // So every one of them now renders inside the persistent J4 layer, above the
  // composer, where the owner can argue with it (app/j4/J4Proposal.tsx). The
  // target still belongs to this page; the decision about it does not. Kept as
  // an empty list rather than deleting the machinery below, because the
  // grouping, focus-deep-linking and per-actionType renderers underneath are
  // real work that a future in-page use may want back — and because an empty
  // filter makes the change obvious to read rather than hidden in a diff.
  const WEBSITE_ACTION_TYPES: string[] = [];
  const websiteApprovals: PendingApproval[] = pendingApprovals.filter((a) =>
    WEBSITE_ACTION_TYPES.includes(a.actionType)
  );
  const websiteApprovalGroups = new Map<string, PendingApproval[]>();
  for (const approval of websiteApprovals) {
    const groupKey = approval.groupId ?? approval.id;
    if (!websiteApprovalGroups.has(groupKey)) websiteApprovalGroups.set(groupKey, []);
    websiteApprovalGroups.get(groupKey)!.push(approval);
  }
  // Contextual deep-linking: websiteApprovals is already scoped to this
  // store/section/PENDING_APPROVAL only, so a match here is automatically
  // valid — invalid/stale/resolved/mismatched ids simply don't match. Same
  // reasoning for websiteObservations, already scoped to this exact page.
  const { focus } = await searchParams;
  const focusedWebsiteApproval = focus ? websiteApprovals.find((a) => a.id === focus) : undefined;
  // Phase 1 (2026-08-08) — observations only; website's own approvals stay
  // on the existing bespoke VisualProposal rendering above (real visual
  // mocks/iframe previews per actionType, deliberately not collapsed into
  // a generic text card — that would be a real regression, not a
  // consistency improvement).
  const websiteObservationCards = buildPageAttentionCards({
    basePath,
    approvals: [],
    observations: websiteObservations,
    highlightId: focus,
    dismissedCardIds,
  });
  // Rendered once, standalone, above the grouped list — remove it from
  // whichever group it belongs to so it never renders twice.
  const remainingApprovalGroups = [...websiteApprovalGroups.entries()]
    .map(([groupKey, group]) => [
      groupKey,
      group.filter((a) => a.id !== focusedWebsiteApproval?.id),
    ] as const)
    .filter(([, group]) => group.length > 0);

  // The owner/employee can always preview their own storefront now, live or
  // not — the same URL a customer would use once published.
  const storeUrl = `${await getBaseUrl()}/store/${store.slug}`;
  const theme = (store.theme as Theme | null) ?? DEFAULT_THEME;
  // Real hero copy, held constant across a theme comparison — only the
  // theme itself should visibly differ between current/proposed.
  const blueprint = store.blueprint as BlueprintContextSubset | null;
  const currentHeroHeadline = blueprint?.homepageContent?.heroHeadline ?? "";
  const currentHeroSubheadline = blueprint?.homepageContent?.heroSubheadline ?? "";

  // Extracted so grouped and ungrouped proposals render identically either
  // way — only the presence of a shared wrapper around 2+ cards differs.
  function renderApprovalCard(approval: PendingApproval, highlighted?: boolean) {
    if (approval.actionType === "update_hero") {
      const current = approval.previousValues as { heroHeadline?: string; heroSubheadline?: string };
      const proposed = approval.input as { heroHeadline: string; heroSubheadline: string };
      return (
        <VisualProposal
          key={approval.id}
          title="J4 has an idea for your homepage"
          summary={approval.summary}
          approvalId={approval.id}
          approveAction={approveGenesisAction}
          rejectAction={rejectGenesisAction}
          highlighted={highlighted}
          current={
            <HeroMock
              theme={theme}
              storeName={store.name}
              tagline={store.tagline}
              heroHeadline={current.heroHeadline ?? ""}
              heroSubheadline={current.heroSubheadline ?? ""}
              productImage={firstProduct?.imageUrl ?? null}
            />
          }
          proposed={
            <HeroMock
              theme={theme}
              storeName={store.name}
              tagline={store.tagline}
              heroHeadline={proposed.heroHeadline}
              heroSubheadline={proposed.heroSubheadline}
              productImage={firstProduct?.imageUrl ?? null}
            />
          }
        />
      );
    }

    if (approval.actionType === "update_theme") {
      const currentProposedTheme = (approval.previousValues as Theme | null) ?? theme;
      const proposedTheme = approval.input as unknown as Theme;
      return (
        <VisualProposal
          key={approval.id}
          title="J4 has a new look for your storefront"
          summary={approval.summary}
          approvalId={approval.id}
          approveAction={approveGenesisAction}
          rejectAction={rejectGenesisAction}
          highlighted={highlighted}
          current={
            <HeroMock
              theme={currentProposedTheme}
              storeName={store.name}
              tagline={store.tagline}
              heroHeadline={currentHeroHeadline}
              heroSubheadline={currentHeroSubheadline}
              productImage={firstProduct?.imageUrl ?? null}
            />
          }
          proposed={
            <HeroMock
              theme={proposedTheme}
              storeName={store.name}
              tagline={store.tagline}
              heroHeadline={currentHeroHeadline}
              heroSubheadline={currentHeroSubheadline}
              productImage={firstProduct?.imageUrl ?? null}
            />
          }
        />
      );
    }

    if (approval.actionType === "update_section_order") {
      // Genesis's first structural Website action — the real storefront
      // renderer, not a mock: "Proposed" is the exact same route with a
      // validated previewOrder override, gated owner/employee-only
      // server-side (see app/store/[slug]/page.tsx). Stacked, since two
      // full-page previews side by side would cramp both.
      const currentOrder = (approval.previousValues as { sectionOrder: SectionKey[] }).sectionOrder;
      const proposedOrder = (approval.input as { sectionOrder: SectionKey[] }).sectionOrder;
      const customSectionTitle = blueprint?.homepageContent?.customSection?.title;
      return (
        <VisualProposal
          key={approval.id}
          title="J4 has a new order for your homepage sections"
          summary={approval.summary}
          approvalId={approval.id}
          approveAction={approveGenesisAction}
          rejectAction={rejectGenesisAction}
          highlighted={highlighted}
          stacked
          note={`${formatOrder(currentOrder, customSectionTitle)} becoming ${formatOrder(proposedOrder, customSectionTitle)}`}
          current={
            <iframe
              src={storeUrl}
              title="Current section order"
              className="h-[520px] w-full rounded-lg border border-black/[.08] bg-white dark:border-white/[.145]"
            />
          }
          proposed={
            <iframe
              src={`${storeUrl}?previewOrder=${encodeURIComponent(proposedOrder.join(","))}`}
              title="Proposed section order"
              className="h-[520px] w-full rounded-lg border border-black/[.08] bg-white dark:border-white/[.145]"
            />
          }
        />
      );
    }

    // update_homepage_content — real field values, honestly presented as
    // text (see FieldValueList) — plus, since Phase 2 Milestone 1 extended
    // this action to cover the structured fields too, two small dedicated
    // renderers for the two shapes that don't fit a flat key/value row:
    // featuredCollections (a plain string list) and faq (a list of Q&A
    // pairs). customSection ({title, body} | null) is small/bounded enough
    // to just flatten into two more FieldValueList rows rather than earn
    // its own component.
    const NON_FLAT_KEYS = new Set(["featuredCollections", "faq", "customSection"]);
    const flatFields = Object.keys(approval.input).filter((key) => !NON_FLAT_KEYS.has(key));
    const flattenValues = (values: Record<string, unknown>) => {
      const customSection = values.customSection as { title: string; body: string } | null;
      return {
        ...values,
        customSectionTitle: customSection?.title ?? "(none)",
        customSectionBody: customSection?.body ?? "(none)",
      };
    };
    const flatFieldsWithCustomSection = [
      ...flatFields,
      ...("customSection" in approval.input ? ["customSectionTitle", "customSectionBody"] : []),
    ];
    const renderHomepageContentSide = (values: Record<string, unknown>) => (
      <div className="flex flex-col gap-2">
        <FieldValueList fields={flatFieldsWithCustomSection} values={flattenValues(values)} />
        {"featuredCollections" in approval.input && (
          <StringListView
            label="Featured Collections"
            items={(values.featuredCollections as string[] | undefined) ?? []}
          />
        )}
        {"faq" in approval.input && (
          <FaqListView items={(values.faq as { question: string; answer: string }[] | undefined) ?? []} />
        )}
      </div>
    );
    return (
      <VisualProposal
        key={approval.id}
        title="J4 has updates for your homepage content"
        summary={approval.summary}
        approvalId={approval.id}
        approveAction={approveGenesisAction}
        rejectAction={rejectGenesisAction}
        highlighted={highlighted}
        stacked
        current={renderHomepageContentSide(approval.previousValues)}
        proposed={renderHomepageContentSide(approval.input)}
      />
    );
  }

  return (
    // Tighter padding on mobile than the p-8 this used to carry everywhere.
    // This is the most space-constrained screen in the product, and every
    // pixel of horizontal padding is a pixel the storefront does not get.
    <div style={themeCssVars(theme)} className="min-h-screen p-4 sm:p-8 lg:min-h-0">
      {/* No "Website" heading (2026-08-12). The owner just tapped Website to
          get here, so the word only repeated what the navigation already
          said, and on mobile that line cost real estate this screen cannot
          spare. This is becoming the place you edit the website with J4, not
          a page that announces itself. */}

      {/* The storefront itself, and deliberately the only thing competing for
          attention. "Open in new tab" is gone: this screen is for working on
          the site, and View Store in the shell remains the intentional way to
          go experience the real storefront as a customer. The live/not-live
          status stays, because whether the thing you are editing is public is
          genuinely part of editing it. */}
      <div className="overflow-hidden rounded-2xl border border-black/[.08] shadow-sm dark:border-white/[.145] lg:max-w-5xl">
        <div className="flex items-center gap-2 border-b border-black/[.08] bg-black/[.02] px-3 py-1.5 text-xs dark:border-white/[.145] dark:bg-white/[.03]">
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              store.published ? "bg-emerald-500" : "bg-zinc-400 dark:bg-zinc-600"
            }`}
          />
          <span className={store.published ? "font-medium text-emerald-600 dark:text-emerald-400" : "text-zinc-500"}>
            {store.published ? "Live" : "Not Live"}
          </span>
        </div>
        {/* Viewport-relative rather than a fixed 640px. On a phone that fixed
            height left the storefront in a small window inside a large empty
            page; on a tall desktop it wasted the bottom half of the screen.
            Now it fills what is actually available, minus the shell's own
            fixed chrome, with a floor so it never collapses on a short
            window. */}
        <iframe
          src={storeUrl}
          title={`${store.name} storefront preview`}
          className="h-[calc(100svh-13rem)] min-h-[420px] w-full bg-white lg:h-[calc(100vh-11rem)]"
        />
      </div>

      {publishError && latestPublishLog && (
        <div className="mt-3 max-w-md rounded-lg border border-red-200 bg-red-50 p-4 text-sm dark:border-red-900/40 dark:bg-red-950/30">
          <p className="font-medium text-red-800 dark:text-red-300">Couldn&apos;t publish your store.</p>
          <p className="mt-1 text-red-700 dark:text-red-400">{latestPublishLog.message}</p>
        </div>
      )}

      {/* Publish/Unpublish — secondary to actually seeing the site above,
          so just the action, not a repeated status readout. */}
      <form action={toggleStorePublished.bind(null, slug)} className="mt-3">
        <SubmitButton
          pendingText="Updating..."
          className={
            store.published
              ? "rounded-full border border-black/[.08] px-3 py-1.5 text-xs text-zinc-600 transition-colors hover:bg-black/[.03] disabled:opacity-50 dark:border-white/[.145] dark:text-zinc-300 dark:hover:bg-white/[.05]"
              : `px-4 py-1.5 text-xs font-medium ${ACCENT_BUTTON}`
          }
        >
          {store.published ? "Unpublish" : "Publish Store"}
        </SubmitButton>
      </form>

      {/* Phase 1 (2026-08-08) — same compact card language Home's own "J4
          Noticed" zone uses, replacing ObservationsPanel here. Approvals
          stay in the bespoke VisualProposal rendering above, untouched. */}
      {/* ============ J4'S NOTICES MOVED TO THE ARRIVAL (2026-09-01) ====
          Sean: "Move this out of the Storefront page. J4's notices/observations
          should be part of the Genesis welcome/arrival experience, not buried
          at the bottom of a particular business page... The notice should feel
          like J4 communicating with the owner, not like another section of the
          Storefront editor."

          The DATA and the dismissal behaviour are untouched — the same
          GenesisObservation rows, read through the same buildPageAttentionCards
          and rendered by the same AttentionCardList. Only WHERE they are shown
          changed, and they are deliberately not duplicated here. */}

      {/* One review surface for every Website proposal — but each card
          stays its own independently-decided ApprovalRequest. Cards sharing
          a groupId (one Genesis "thought") get one shared header; every
          card underneath still has its own real Approve/Reject — grouping
          never combines them into one decision. */}
      {websiteApprovals.length > 0 && (
        <>
          <h2 className="mt-10 text-lg font-semibold text-black dark:text-zinc-50">
            Genesis&apos;s ideas for your site ({websiteApprovals.length})
          </h2>
          <div className="mt-3 flex flex-col gap-4">
            {focusedWebsiteApproval && renderApprovalCard(focusedWebsiteApproval, true)}
            {remainingApprovalGroups.map(([groupKey, group]) =>
              group.length > 1 ? (
                <div
                  key={groupKey}
                  className="rounded-2xl border border-dashed border-[var(--brand-accent)]/25 p-3"
                >
                  <div className="flex items-center justify-between gap-2 px-2 pb-2">
                    <p className="text-xs font-medium text-zinc-500">
                      Genesis has {group.length} related changes from one idea
                    </p>
                    <form action={approveGenesisActionGroup.bind(null, groupKey, slug)}>
                      <button
                        type="submit"
                        className="rounded-full bg-[var(--brand-accent,var(--foreground))] px-2.5 py-1 text-xs font-medium text-white transition-opacity hover:opacity-90"
                      >
                        Use all {group.length}
                      </button>
                    </form>
                  </div>
                  <div className="flex flex-col gap-4">{group.map((approval) => renderApprovalCard(approval))}</div>
                </div>
              ) : (
                renderApprovalCard(group[0])
              )
            )}
          </div>
        </>
      )}

      {/* Vision history — real, preserved, no longer dominant by default */}
      <details className="mt-6 max-w-md">
        <summary className="cursor-pointer text-sm text-zinc-500 underline">
          Vision history
        </summary>
        {originalVision ? (
          <ul className="mt-3 flex flex-col gap-3">
            <li className="rounded-lg border border-black/[.08] p-4 dark:border-white/[.145]">
              <p className="font-medium text-black dark:text-zinc-50">Original Vision</p>
              <p className="mt-1 text-xs text-zinc-500">
                The first version J4 created from your original idea.
              </p>
              <p className="mt-1 text-xs text-zinc-400">
                {originalVision.createdAt.toLocaleDateString()}
              </p>
            </li>
            {firstRefinedVision && (
              <li className="rounded-lg border border-black/[.08] p-4 dark:border-white/[.145]">
                <p className="font-medium text-black dark:text-zinc-50">First Refined Vision</p>
                <p className="mt-1 text-xs text-zinc-500">
                  The first version you chose to bring to life.
                </p>
                <p className="mt-1 text-xs text-zinc-400">
                  {firstRefinedVision.createdAt.toLocaleDateString()}
                </p>
              </li>
            )}
            <li className="rounded-lg border border-black/[.08] p-4 dark:border-white/[.145]">
              <p className="font-medium text-black dark:text-zinc-50">Current Vision</p>
              <p className="mt-1 text-xs text-zinc-500">
                The version currently powering your store.
              </p>
              <p className="mt-1 text-xs text-zinc-400">
                {store.updatedAt.toLocaleDateString()}
              </p>
            </li>
          </ul>
        ) : (
          <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">No vision history yet.</p>
        )}
      </details>
    </div>
  );
}


// The legacy route — resolves the account's ACTIVE business and renders the same
// screen /b/<slug>/website renders. Preserved rather than redirected: existing
// links and bookmarks point here.
export default async function WebsitePage({
  searchParams,
}: {
  searchParams: Promise<{ focus?: string; publish_error?: string }>;
}) {
  return WebsiteScreen({ basePath: LEGACY_BUSINESS_BASE, searchParams });
}
