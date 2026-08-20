import { prisma } from "@/lib/prisma";
import { PERMISSIONS, hasPermission, requireBusinessPageOrActive } from "@/lib/permissions";
import { LEGACY_BUSINESS_BASE } from "@/lib/dashboard/navConfig";
import type { BlueprintContextSubset } from "@/lib/execution/genesisActions";
import { getPendingApprovals } from "@/lib/dashboard/pendingApprovals";
import { buildPageAttentionCards, getDismissedCardIds } from "@/lib/dashboard/attentionCards";
import {
  approveGenesisAction,
  rejectGenesisAction,
  approveGenesisActionGroup,
  regenerateApprovalImage,
  revertApprovalRequest,
  startIssueConversation,
  startDiscoveryConversation,
  startTaskConversation,
  dismissAttentionCard,
} from "../ai-actions";
import { grantAuthority, revokeAuthority } from "../actions";
import { AttentionCardList } from "../AttentionCardList";
import { SubmitButton } from "../SubmitButton";
import { RevertDecisionButton } from "../RevertDecisionButton";
import { DEFAULT_THEME, themeCssVars, type Theme } from "@/lib/theme";

// The real, wired-up capabilities today: SEO (Genesis-editable via chat,
// approval-gated, shown here read-only) and the newsletter subscriber list
// (real data that already existed with zero UI reading it — see the nav
// plan). A manual SEO edit form, social bios brought to the same parity,
// and "Social" folding in here once platform connections exist are the
// next build on this route, not part of this pass.
// MIGRATED to explicit business context (2026-08-20, BUSINESS_CONTEXT.md Phase
// C). The screen is unchanged. What changed is where it gets its business: a
// `slug` means it was reached at /b/[slug] and that business is authoritative;
// no slug means the legacy /dashboard route, which resolves the account's active
// business exactly as before.
//
// `basePath` is what every link inside uses, so a page rendered for one business
// never links into another.
export async function MarketingScreen({ slug, basePath }: { slug?: string; basePath: string }) {
  const { store, role } = await requireBusinessPageOrActive(PERMISSIONS.STORE_MANAGE, slug);
  const canManageAuthority = hasPermission(role, PERMISSIONS.AUTHORITY_MANAGE);

  const [subscribers, pendingApprovals, seoAuthorityGrant, recentSeoDecisions, dismissedCardIds] = await Promise.all([
    prisma.newsletterSignup.findMany({
      where: { storeId: store.id },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
    getPendingApprovals(store.id),
    prisma.delegatedAuthority.findFirst({
      where: { storeId: store.id, actionType: "update_seo", revokedAt: null },
    }),
    // Phase 6 — recent decided (not pending) update_seo approvals, human or
    // autonomous, each with a Revert affordance — the safety valve for
    // autonomous execution in particular, since it skips the moment a human
    // could otherwise have caught something before it happened.
    prisma.approvalRequest.findMany({
      where: { storeId: store.id, actionType: "update_seo", status: "EXECUTED" },
      orderBy: { decidedAt: "desc" },
      take: 5,
    }),
    getDismissedCardIds(store.id),
  ]);
  const seoApprovals = pendingApprovals.filter((a) => a.actionType === "update_seo");
  // Phase 2 Milestone 1 — brandKeywords/instagramBio/facebookDescription/
  // xBio now flow through the same approval framework SEO already uses,
  // closing one more piece of the chat-vs-manual fork.
  const marketingAssetsApprovals = pendingApprovals.filter((a) => a.actionType === "update_marketing_assets");
  // Phase 1 (2026-08-08) — same compact card language as every other
  // secondary page now uses; kept as two separate lists under their own
  // existing, distinct headings (real, different meaning: a direct SEO
  // approval vs. a broader social-presence proposal) rather than merged
  // into one — only the card rendering changes, not this page's own
  // structure. No observations on this page (unchanged).
  const seoCards = buildPageAttentionCards({ approvals: seoApprovals, observations: [], dismissedCardIds });
  const marketingAssetsCards = buildPageAttentionCards({ approvals: marketingAssetsApprovals, observations: [], dismissedCardIds });

  const blueprint = store.blueprint as BlueprintContextSubset | null;
  const seoTitle = blueprint?.marketingAssets?.seoTitle;
  const seoMetaDescription = blueprint?.marketingAssets?.seoMetaDescription;
  const brandKeywords = blueprint?.marketingAssets?.brandKeywords ?? [];
  const instagramBio = blueprint?.marketingAssets?.instagramBio;
  const facebookDescription = blueprint?.marketingAssets?.facebookDescription;
  const xBio = blueprint?.marketingAssets?.xBio;
  const theme = (store.theme as Theme | null) ?? DEFAULT_THEME;

  return (
    <div style={themeCssVars(theme)} className="min-h-screen p-8 lg:min-h-0">
      <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">Marketing</h1>

      {seoCards.length > 0 && (
        <>
          <h2 className="mt-8 text-lg font-semibold text-black dark:text-zinc-50">
            Awaiting Your Approval ({seoCards.length})
          </h2>
          <div className="mt-3">
            <AttentionCardList
              cards={seoCards}
              approveAction={approveGenesisAction}
              rejectAction={rejectGenesisAction}
              approveGroupAction={approveGenesisActionGroup}
              issueAction={startIssueConversation}
              discoveryAction={startDiscoveryConversation}
              taskAction={startTaskConversation}
              regenerateAction={regenerateApprovalImage}
              dismissAction={dismissAttentionCard}
              currentPath={`${basePath}/marketing`}
            />
          </div>
        </>
      )}

      {marketingAssetsCards.length > 0 && (
        <>
          <h2 className="mt-8 text-lg font-semibold text-black dark:text-zinc-50">
            Genesis&apos;s ideas for your social presence ({marketingAssetsCards.length})
          </h2>
          <div className="mt-3">
            <AttentionCardList
              cards={marketingAssetsCards}
              approveAction={approveGenesisAction}
              rejectAction={rejectGenesisAction}
              approveGroupAction={approveGenesisActionGroup}
              issueAction={startIssueConversation}
              discoveryAction={startDiscoveryConversation}
              taskAction={startTaskConversation}
              regenerateAction={regenerateApprovalImage}
              dismissAction={dismissAttentionCard}
              currentPath={`${basePath}/marketing`}
            />
          </div>
        </>
      )}

      {canManageAuthority && (
        <>
          <h2 className="mt-8 text-lg font-semibold text-black dark:text-zinc-50">
            Genesis&apos;s authority
          </h2>
          <p className="mt-2 max-w-md text-sm text-zinc-600 dark:text-zinc-400">
            {seoAuthorityGrant
              ? "Genesis can publish SEO improvements automatically, without waiting for your approval."
              : "Genesis will always ask before changing your SEO title or description."}
          </p>
          <form action={(seoAuthorityGrant ? revokeAuthority : grantAuthority).bind(null, slug)} className="mt-3">
            <input type="hidden" name="actionType" value="update_seo" />
            <SubmitButton
              pendingText={seoAuthorityGrant ? "Revoking..." : "Granting..."}
              className={
                seoAuthorityGrant
                  ? "rounded-full border border-black/[.08] px-4 py-1.5 text-xs text-zinc-600 transition-colors hover:bg-black/[.03] disabled:opacity-50 dark:border-white/[.145] dark:text-zinc-300 dark:hover:bg-white/[.05]"
                  : "rounded-full bg-[var(--brand-accent,var(--foreground))] px-4 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              }
            >
              {seoAuthorityGrant ? "Ask before publishing SEO changes" : "Let Genesis publish SEO improvements automatically"}
            </SubmitButton>
          </form>
        </>
      )}

      {recentSeoDecisions.length > 0 && (
        <>
          <h2 className="mt-8 text-lg font-semibold text-black dark:text-zinc-50">
            Recently handled
          </h2>
          <ul className="mt-3 flex max-w-md flex-col gap-3">
            {recentSeoDecisions.map((decision) => (
              <li
                key={decision.id}
                className="rounded-lg border border-black/[.08] p-3 dark:border-white/[.145]"
              >
                <p className="text-sm text-black dark:text-zinc-50">{decision.summary}</p>
                <p className="mt-1 text-xs text-zinc-500">
                  {decision.decisionMode === "autonomous"
                    ? "Handled by Genesis automatically"
                    : "You approved this"}
                  {decision.decidedAt ? ` — ${decision.decidedAt.toLocaleDateString()}` : ""}
                </p>
                <RevertDecisionButton action={revertApprovalRequest.bind(null, decision.id)} />
              </li>
            ))}
          </ul>
        </>
      )}

      <h2 className="mt-8 text-lg font-semibold text-black dark:text-zinc-50">SEO</h2>
      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
        Ask J4 to update your SEO title or description — changes go
        through the usual approval step.
      </p>
      <div className="mt-4 max-w-md rounded-lg border border-black/[.08] p-4 dark:border-white/[.145]">
        <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Title</p>
        <p className="mt-1 text-sm text-black dark:text-zinc-50">
          {seoTitle || "Not set yet"}
        </p>
        <p className="mt-3 text-xs font-medium uppercase tracking-wide text-zinc-500">
          Meta description
        </p>
        <p className="mt-1 text-sm text-black dark:text-zinc-50">
          {seoMetaDescription || "Not set yet"}
        </p>
      </div>

      <h2 className="mt-10 text-lg font-semibold text-black dark:text-zinc-50">Social presence</h2>
      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
        Ask J4 to update your social bios or keywords — changes go
        through the usual approval step, same as SEO.
      </p>
      <div className="mt-4 max-w-md rounded-lg border border-black/[.08] p-4 dark:border-white/[.145]">
        <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Brand keywords</p>
        <p className="mt-1 text-sm text-black dark:text-zinc-50">
          {brandKeywords.length > 0 ? brandKeywords.join(", ") : "Not set yet"}
        </p>
        <p className="mt-3 text-xs font-medium uppercase tracking-wide text-zinc-500">Instagram bio</p>
        <p className="mt-1 text-sm text-black dark:text-zinc-50">{instagramBio || "Not set yet"}</p>
        <p className="mt-3 text-xs font-medium uppercase tracking-wide text-zinc-500">
          Facebook description
        </p>
        <p className="mt-1 text-sm text-black dark:text-zinc-50">{facebookDescription || "Not set yet"}</p>
        <p className="mt-3 text-xs font-medium uppercase tracking-wide text-zinc-500">X (Twitter) bio</p>
        <p className="mt-1 text-sm text-black dark:text-zinc-50">{xBio || "Not set yet"}</p>
      </div>

      <h2 className="mt-10 text-lg font-semibold text-black dark:text-zinc-50">
        Newsletter subscribers ({subscribers.length})
      </h2>
      {subscribers.length === 0 ? (
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          No signups yet — your storefront&apos;s newsletter form will list
          them here as they come in.
        </p>
      ) : (
        <ul className="mt-4 max-w-md flex-col gap-1.5 divide-y divide-black/[.05] rounded-lg border border-black/[.08] dark:divide-white/[.08] dark:border-white/[.145]">
          {subscribers.map((sub) => (
            <li key={sub.id} className="flex items-center justify-between px-3 py-2 text-sm">
              <span className="text-black dark:text-zinc-50">{sub.email}</span>
              <span className="text-xs text-zinc-500">{sub.createdAt.toLocaleDateString()}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}


// The legacy route — resolves the account's ACTIVE business and renders the same
// screen /b/<slug>/marketing renders. Preserved rather than redirected: existing
// links and bookmarks point here.
export default async function MarketingPage() {
  return MarketingScreen({ basePath: LEGACY_BUSINESS_BASE });
}
