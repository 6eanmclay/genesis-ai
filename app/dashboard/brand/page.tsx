import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { PERMISSIONS, hasPermission, requireBusinessPageOrActive } from "@/lib/permissions";
import { LEGACY_BUSINESS_BASE } from "@/lib/dashboard/navConfig";
import { getPendingApprovals } from "@/lib/dashboard/pendingApprovals";
import { FIELD_LABELS, type BlueprintContextSubset } from "@/lib/execution/genesisActions";
import { compareObservationPriority } from "@/lib/dashboard/genesisState";
import { buildPageAttentionCards, getDismissedCardIds } from "@/lib/dashboard/attentionCards";
import {
  approveGenesisAction,
  rejectGenesisAction,
  approveGenesisActionGroup,
  startIssueConversation,
  startDiscoveryConversation,
  startTaskConversation,
  dismissAttentionCard,
} from "../ai-actions";
import { EditStoreForm } from "../EditStoreForm";
import { AttentionCardList } from "../AttentionCardList";
import { DEFAULT_THEME, themeCssVars, type Theme } from "@/lib/theme";

// The 9 AI-generated identity fields, in the same order FIELD_LABELS
// already names them — no manual edit form exists for these today (only
// Genesis, via chat, can propose changes through update_brand_identity), so
// they render read-only here. This is the one genuinely new thing this page
// adds: nowhere before today could an owner see their own brand identity at
// rest — only ever mid-approval, as a diff.
const BRAND_IDENTITY_FIELDS = [
  "brandStory",
  "missionStatement",
  "visionStatement",
  "brandPromise",
  "coreValues",
  "brandPersonality",
  "brandVoiceAndTone",
  "targetAudience",
  "uniqueSellingProposition",
] as const;

function formatIdentityValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : "Not set yet";
  return value && value.trim().length > 0 ? value : "Not set yet";
}

// Product Vision Phase 1 — the real, single home for "who this business
// is": business name/tagline/description (previously Settings' "Store
// info") and the full AI-generated brand identity (previously visible only
// as an approval diff, never at rest), plus the update_brand_identity/
// update_store_identity approval experience itself (previously routed to
// Settings — see ACTION_SECTIONS in lib/execution/genesisActions.ts). Reads
// directly from Store's existing fields and blueprint.brandIdentity —
// no duplicated state, no new data model.
// MIGRATED to explicit business context (2026-08-20, BUSINESS_CONTEXT.md Phase
// C). The screen is unchanged. What changed is where it gets its business: a
// `slug` means it was reached at /b/[slug] and that business is authoritative;
// no slug means the legacy /dashboard route, which resolves the account's active
// business exactly as before.
//
// `basePath` is what every link inside uses, so a page rendered for one business
// never links into another.
export async function BrandScreen({
  slug,
  basePath,
  searchParams,
}: {
  slug?: string;
  basePath: string;
  searchParams: Promise<{ focus?: string }>;
}) {
  const { store, role } = await requireBusinessPageOrActive(PERMISSIONS.STORE_MANAGE, slug);
  const canReviewApprovals = hasPermission(role, PERMISSIONS.ANALYTICS_VIEW);
  const [pendingApprovals, rawObservations, dismissedCardIds] = await Promise.all([
    canReviewApprovals ? getPendingApprovals(store.id) : Promise.resolve([]),
    // Real GenesisObservation rows (Red/Purple) whose own actionHref points
    // directly at this page — the same real data Live Intelligence/the nav
    // badges already use, just filtered to this one destination.
    prisma.genesisObservation.findMany({
      where: { storeId: store.id, status: "ACTIVE", actionHref: "/dashboard/brand" },
      select: { dedupeKey: true, genesisState: true, summary: true },
    }),
    getDismissedCardIds(store.id),
  ]);
  const brandObservations = [...rawObservations].sort(compareObservationPriority);
  const identityApprovals = pendingApprovals.filter(
    (a) => a.actionType === "update_brand_identity" || a.actionType === "update_store_identity"
  );
  const { focus } = await searchParams;
  // Phase 1 (2026-08-08) — one unified card list instead of two separate
  // sections/components (ObservationsPanel + ApprovalRequestsPanel). focus
  // is passed straight through: isHighlighted() only ever matches a real
  // card's own approvalRequestId/dedupeKey, so an invalid/stale focus
  // value is already a safe no-op, same as before.
  const brandCards = buildPageAttentionCards({
    basePath,
    approvals: identityApprovals,
    observations: brandObservations,
    highlightId: focus,
    dismissedCardIds,
  });

  const brandIdentity = (store.blueprint as BlueprintContextSubset | null)?.brandIdentity;
  const theme = (store.theme as Theme | null) ?? DEFAULT_THEME;

  return (
    <div style={themeCssVars(theme)} className="min-h-screen p-8 lg:min-h-0">
      {/* Beta polish pass (v22) — aligned to "Identity," the deliberate
          user-facing word already chosen for this section's nav tab (see
          navConfig.ts's YOUR_BUSINESS_SECTIONS comment) — the page heading
          had never been updated to match. Route/key/data stay "brand"
          throughout, unchanged. */}
      <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">Identity</h1>
      <p className="mt-2 max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
        Who your business is — the identity every part of your presence draws from.
      </p>

      {/* Phase 1 (2026-08-08) — one unified card list (real issues/
          decisions Genesis noticed about your identity), same compact
          language Home's own "J4 Noticed" zone uses — replaces the two
          separate ObservationsPanel/ApprovalRequestsPanel sections this
          page used to render on its own. */}
      {brandCards.length > 0 && (
        <>
          <h2 className="mt-6 text-lg font-semibold text-black dark:text-zinc-50">
            Genesis noticed ({brandCards.length})
          </h2>
          <div className="mt-3">
            <AttentionCardList
              cards={brandCards}
              approveAction={approveGenesisAction}
              rejectAction={rejectGenesisAction}
              approveGroupAction={approveGenesisActionGroup}
              issueAction={startIssueConversation}
              discoveryAction={startDiscoveryConversation}
              taskAction={startTaskConversation}
              highlightId={focus}
              dismissAction={dismissAttentionCard}
              currentPath={`${basePath}/brand`}
              slug={slug}
            />
          </div>
        </>
      )}

      {/* ============ TWO KINDS OF IDENTITY, SAID OUT LOUD (2026-09-01) ====
          Sean: "Identity is mixing basic business facts with the much deeper
          Brand Identity that J4 generates. I want to separate those concepts
          cleanly."

          They were already in this order and under two headings. What was
          missing is the thing that makes them different kinds of statement:

            Business identity   what the business SAYS IT IS. The owner's,
                                editable, no ceremony.
            Brand identity      what J4 has MADE OF THAT. An interpretation,
                                changed by agreement rather than overwriting.

          The headings alone did not carry that — "Business identity" and
          "Brand identity" read as two groups of fields, one of which happened
          to have no inputs. The sentence under each says whose it is, which is
          the whole distinction this milestone exists to draw. */}
      <h2 className="mt-8 text-lg font-semibold text-black dark:text-zinc-50">Business identity</h2>
      <p className="mt-1 max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
        What your business says it is. These are yours to set, and you can change them whenever
        you like.
      </p>
      <EditStoreForm
        // ============ THE BUSINESS IN THE URL, NOT THE ACTIVE ONE ========
        //
        // FOUND 2026-09-01, while splitting this screen. The screen resolved
        // the business from the slug and rendered its name, and this form was
        // handed no slug at all — so `editStore(undefined, …)` fell through
        // requireBusinessOrActive to requireStorePermission, which resolves
        // whichever business the ACCOUNT was last active in.
        //
        // On /b/<slug>/brand with a different business active, the form showed
        // one business's name and renamed another. The prop existed for exactly
        // this and its own doc comment says so; the call site never passed it.
        //
        // Nothing was corrupted in production: every store here belongs to the
        // same owner and the active business has been the one being looked at.
        // It is a latent wrong-tenant WRITE, which is not a class of bug to
        // leave sitting because it has not fired yet.
        slug={slug}
        store={{ name: store.name, tagline: store.tagline, description: store.description }}
      />
      {/* THE NAME AND THE ADDRESS ARE NOT THE SAME FACT. `editStoreExecutable`
          writes name, tagline and description and never touches `slug`, which
          is what the storefront and every /b/<slug> link are built from. An
          owner who renames and expects their web address to follow should find
          that out here rather than by checking. */}
      <p className="mt-3 max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
        Renaming your business does not change its web address. Your storefront stays at{" "}
        <span className="font-medium text-black dark:text-zinc-50">/store/{store.slug}</span>.
      </p>

      <h2 className="mt-10 text-lg font-semibold text-black dark:text-zinc-50">Brand identity</h2>
      {/* Real mobile beta feedback (2026-08-06) — "J-4" here, deliberately,
          not "Genesis": Genesis is the environment, J-4 is the intelligence
          that actually generated this content, and this one label was
          conceptually inaccurate. A single, deliberate correction, not the
          start of the broader Genesis->J-4 migration VISION.md explicitly
          keeps deferred to its own dedicated design pass — every other
          Genesis reference in this app is untouched on purpose. */}
      {/* Copy rule (2026-08-12, permanent): no hyphenated word joins and no
          dash-heavy construction in conversational copy. Separate sentences,
          commas, and ordinary punctuation instead. Also J4 rather than J-4,
          matching the naming audit applied across the rest of the app. */}
      {/* NOT "generated by J4", which describes how the text was produced and
          says nothing about what it IS. This is J4's reading of the business —
          the strategic interpretation it forms from what it understands — and
          naming it that is what makes the "talk with J4 first" line below a
          principle rather than a locked form. */}
      <p className="mt-1 max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
        What J4 has made of your business. This is its interpretation, not a set of facts you
        entered, and it shapes tone, voice, and design everywhere.
      </p>
      <dl className="mt-4 flex max-w-2xl flex-col gap-3 rounded-xl border border-black/[.08] bg-black/[.02] p-4 dark:border-white/[.145] dark:bg-white/[.03]">
        {BRAND_IDENTITY_FIELDS.map((key) => (
          <div key={key}>
            <dt className="text-xs font-medium uppercase tracking-wide text-zinc-500">{FIELD_LABELS[key]}</dt>
            <dd className="mt-0.5 text-sm text-black dark:text-zinc-50">
              {formatIdentityValue(brandIdentity?.[key])}
            </dd>
          </div>
        ))}
      </dl>

      {/* Brand identity is deliberately not casually editable (2026-08-12).
          The point is not to stop an owner changing it, it is to make sure
          they understand what changing it affects and agree to that before J4
          acts. Sean's framing: the identity should feel intentional, not like
          a field you overwrite on a whim.
          Deliberately a quiet line rather than a warning callout. This is
          guidance, not an error, and the dashboard is meant to feel calm
          rather than to add another coloured box competing for attention. */}
      <p className="mt-3 max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
        Want to change your brand identity?{" "}
        <Link href="/j4" className="font-medium text-black underline underline-offset-2 dark:text-zinc-50">
          Talk with J4 first
        </Link>{" "}
        so you can review the change together. Your identity shapes tone, voice, and design everywhere, so it is worth
        deciding on purpose.
      </p>
    </div>
  );
}


// The legacy route — resolves the account's ACTIVE business and renders the same
// screen /b/<slug>/brand renders. Preserved rather than redirected: existing
// links and bookmarks point here.
export default async function BrandPage({
  searchParams,
}: {
  searchParams: Promise<{ focus?: string }>;
}) {
  return BrandScreen({ basePath: LEGACY_BUSINESS_BASE, searchParams });
}
