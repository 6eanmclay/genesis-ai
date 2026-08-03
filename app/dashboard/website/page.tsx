import { prisma } from "@/lib/prisma";
import { PERMISSIONS, requireStorePageAccess } from "@/lib/permissions";
import { EXECUTION_ACTIONS } from "@/lib/execution/actions";
import { getBaseUrl } from "@/lib/integrations/util";
import { getPendingApprovals, type PendingApproval } from "@/lib/dashboard/pendingApprovals";
import type { BlueprintContextSubset } from "@/lib/execution/genesisActions";
import { SECTION_LABELS, type SectionKey } from "@/lib/storefrontSections";
import { compareObservationPriority } from "@/lib/dashboard/genesisState";
import { toggleStorePublished } from "../actions";
import { approveGenesisAction, rejectGenesisAction, approveGenesisActionGroup } from "../ai-actions";
import { SubmitButton } from "../SubmitButton";
import { VisualProposal } from "../VisualProposal";
import { HeroMock } from "../HeroMock";
import { ObservationsPanel } from "../ObservationsPanel";
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
export default async function WebsitePage({
  searchParams,
}: {
  searchParams: Promise<{ focus?: string; publish_error?: string }>;
}) {
  const { store } = await requireStorePageAccess(PERMISSIONS.STORE_MANAGE);
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

  const [visions, pendingApprovals, firstProduct, rawObservations] = await Promise.all([
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
  const WEBSITE_ACTION_TYPES = [
    "update_hero",
    "update_theme",
    "update_homepage_content",
    "update_section_order",
  ];
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
  const highlightObservationId =
    focus && websiteObservations.some((o) => o.dedupeKey === focus) ? focus : undefined;
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
          title="Genesis has an idea for your homepage"
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
          title="Genesis has a new look for your storefront"
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
          title="Genesis has a new order for your homepage sections"
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
        title="Genesis has updates for your homepage content"
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
    <div style={themeCssVars(theme)} className="min-h-screen p-8 lg:min-h-0">
      <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">Website</h1>

      {/* The storefront itself — the unmistakable visual center of the
          workspace. The toolbar above the iframe is part of this one
          preview frame, not a separate dashboard section: status and
          "open in a new tab" read like browser chrome, not page controls. */}
      <div className="mt-6 max-w-4xl overflow-hidden rounded-2xl border border-black/[.08] shadow-sm dark:border-white/[.145]">
        <div className="flex items-center justify-between border-b border-black/[.08] bg-black/[.02] px-4 py-2 dark:border-white/[.145] dark:bg-white/[.03]">
          <span className="flex items-center gap-2 text-xs">
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                store.published ? "bg-emerald-500" : "bg-zinc-400 dark:bg-zinc-600"
              }`}
            />
            <span
              className={
                store.published
                  ? "font-medium text-emerald-600 dark:text-emerald-400"
                  : "text-zinc-500"
              }
            >
              {store.published ? "Live" : "Not Live"}
            </span>
          </span>
          <a
            href={storeUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-zinc-500 transition-colors hover:text-black dark:hover:text-zinc-50"
          >
            Open in new tab ↗
          </a>
        </div>
        <iframe
          src={storeUrl}
          title={`${store.name} storefront preview`}
          className="h-[640px] w-full bg-white"
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
      <form action={toggleStorePublished} className="mt-3">
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

      {/* Real GenesisObservation rows (Red/Purple) — separate from the
          approval surface below; observations have no Approve/Reject, they
          resolve automatically when the real condition stops being true. */}
      {websiteObservations.length > 0 && (
        <>
          <h2 className="mt-10 text-lg font-semibold text-black dark:text-zinc-50">
            Genesis noticed ({websiteObservations.length})
          </h2>
          <ObservationsPanel observations={websiteObservations} highlightId={highlightObservationId} />
        </>
      )}

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
                    <form action={approveGenesisActionGroup.bind(null, groupKey)}>
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
                The first version Genesis created from your original idea.
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
