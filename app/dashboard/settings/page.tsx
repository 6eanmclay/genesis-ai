import { PERMISSIONS, requireStorePageAccess } from "@/lib/permissions";
import { DEFAULT_THEME, themeCssVars, type Theme } from "@/lib/theme";
import type { BlueprintContextSubset } from "@/lib/execution/genesisActions";
import { getPendingApprovals } from "@/lib/dashboard/pendingApprovals";
import { buildPageAttentionCards, getDismissedCardIds } from "@/lib/dashboard/attentionCards";
import {
  approveGenesisAction,
  rejectGenesisAction,
  approveGenesisActionGroup,
  regenerateApprovalImage,
  startIssueConversation,
  startDiscoveryConversation,
  startTaskConversation,
  dismissAttentionCard,
} from "../ai-actions";
import { AttentionCardList } from "../AttentionCardList";

// Product Vision Phase 1 — business identity (name/tagline/description,
// brand story/mission/etc., and the update_brand_identity/
// update_store_identity approval experience) all moved to Brand
// (app/dashboard/brand/page.tsx), their real home — see
// lib/execution/genesisActions.ts's ACTION_SECTIONS.
//
// Phase 2 Milestone 1 — Settings' real first content: store policies
// (shipping/return/privacy/terms/contact) and design direction, the two
// remaining business-configuration field groups that used to bypass
// approval entirely via chat's old direct-write path. Business-
// configuration-shaped, not creative identity (Brand) or storefront-visual
// content (Website), so they land here rather than either of those.
export default async function SettingsPage() {
  const { store } = await requireStorePageAccess(PERMISSIONS.STORE_MANAGE);
  const theme = (store.theme as Theme | null) ?? DEFAULT_THEME;

  const [pendingApprovals, dismissedCardIds] = await Promise.all([
    getPendingApprovals(store.id),
    getDismissedCardIds(store.id),
  ]);
  const storeContentApprovals = pendingApprovals.filter((a) => a.actionType === "update_store_content");
  const designDirectionApprovals = pendingApprovals.filter(
    (a) => a.actionType === "update_design_direction"
  );
  // Phase 1 (2026-08-08) — same compact card language as every other
  // secondary page now uses; kept as two separate lists under their own
  // existing headings, only the card rendering changes.
  const storeContentCards = buildPageAttentionCards({ approvals: storeContentApprovals, observations: [], dismissedCardIds });
  const designDirectionCards = buildPageAttentionCards({ approvals: designDirectionApprovals, observations: [], dismissedCardIds });

  const blueprint = store.blueprint as BlueprintContextSubset | null;
  const storeContent = blueprint?.storeContent;
  const designDirection = blueprint?.designDirection;

  const hasAnyContent =
    storeContentApprovals.length > 0 ||
    designDirectionApprovals.length > 0 ||
    Object.values(storeContent ?? {}).some(Boolean) ||
    Object.values(designDirection ?? {}).some(Boolean);

  return (
    <div style={themeCssVars(theme)} className="min-h-screen p-8 lg:min-h-0">
      <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">Settings</h1>
      <p className="mt-2 max-w-md text-sm text-zinc-600 dark:text-zinc-400">
        Your business identity (name, tagline, brand story) lives on the
        Identity page. This is where store policies and Genesis&apos;s design
        direction live — ask Genesis to update either, and changes go
        through the usual approval step.
      </p>

      {!hasAnyContent && (
        <p className="mt-6 text-sm text-zinc-600 dark:text-zinc-400">
          Nothing set yet — ask Genesis about your shipping policy, return
          policy, or overall design direction and it&apos;ll show up here for
          review.
        </p>
      )}

      {storeContentCards.length > 0 && (
        <>
          <h2 className="mt-8 text-lg font-semibold text-black dark:text-zinc-50">
            Genesis&apos;s updates to your policies ({storeContentCards.length})
          </h2>
          <div className="mt-3">
            <AttentionCardList
              cards={storeContentCards}
              approveAction={approveGenesisAction}
              rejectAction={rejectGenesisAction}
              approveGroupAction={approveGenesisActionGroup}
              issueAction={startIssueConversation}
              discoveryAction={startDiscoveryConversation}
              taskAction={startTaskConversation}
              regenerateAction={regenerateApprovalImage}
              dismissAction={dismissAttentionCard}
              currentPath="/dashboard/settings"
            />
          </div>
        </>
      )}

      {storeContent && Object.values(storeContent).some(Boolean) && (
        <>
          <h2 className="mt-10 text-lg font-semibold text-black dark:text-zinc-50">Store policies</h2>
          <div className="mt-4 flex max-w-md flex-col gap-3 rounded-lg border border-black/[.08] p-4 dark:border-white/[.145]">
            {(
              [
                ["Shipping Policy", storeContent.shippingPolicy],
                ["Return Policy", storeContent.returnPolicy],
                ["Privacy Policy", storeContent.privacyPolicy],
                ["Terms & Conditions", storeContent.termsAndConditions],
                ["Contact Page", storeContent.contactPageCopy],
              ] as const
            ).map(([label, value]) => (
              <div key={label}>
                <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</p>
                <p className="mt-1 text-sm text-black dark:text-zinc-50">{value || "Not set yet"}</p>
              </div>
            ))}
          </div>
        </>
      )}

      {designDirectionCards.length > 0 && (
        <>
          <h2 className="mt-10 text-lg font-semibold text-black dark:text-zinc-50">
            Genesis&apos;s updates to your design direction ({designDirectionCards.length})
          </h2>
          <div className="mt-3">
            <AttentionCardList
              cards={designDirectionCards}
              approveAction={approveGenesisAction}
              rejectAction={rejectGenesisAction}
              approveGroupAction={approveGenesisActionGroup}
              issueAction={startIssueConversation}
              discoveryAction={startDiscoveryConversation}
              taskAction={startTaskConversation}
              regenerateAction={regenerateApprovalImage}
              dismissAction={dismissAttentionCard}
              currentPath="/dashboard/settings"
            />
          </div>
        </>
      )}

      {designDirection && Object.values(designDirection).some(Boolean) && (
        <>
          <h2 className="mt-10 text-lg font-semibold text-black dark:text-zinc-50">Design direction</h2>
          <p className="mt-2 max-w-md text-xs text-zinc-500">
            Steers how Genesis approaches future visuals for your store — not
            shown to customers directly.
          </p>
          <div className="mt-4 flex max-w-md flex-col gap-3 rounded-lg border border-black/[.08] p-4 dark:border-white/[.145]">
            {(
              [
                ["Visual Style", designDirection.visualStyle],
                ["Brand Mood", designDirection.brandMood],
                ["Photography Style", designDirection.photographyStyle],
                ["Icon Style", designDirection.iconStyle],
              ] as const
            ).map(([label, value]) => (
              <div key={label}>
                <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</p>
                <p className="mt-1 text-sm text-black dark:text-zinc-50">{value || "Not set yet"}</p>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
