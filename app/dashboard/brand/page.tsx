import { prisma } from "@/lib/prisma";
import { PERMISSIONS, hasPermission, requireStorePageAccess } from "@/lib/permissions";
import { getPendingApprovals } from "@/lib/dashboard/pendingApprovals";
import { FIELD_LABELS, type BlueprintContextSubset } from "@/lib/execution/genesisActions";
import { compareObservationPriority } from "@/lib/dashboard/genesisState";
import { editStore } from "../actions";
import { approveGenesisAction, rejectGenesisAction, regenerateApprovalImage } from "../ai-actions";
import { SubmitButton } from "../SubmitButton";
import { ApprovalRequestsPanel } from "../ApprovalRequestsPanel";
import { ObservationsPanel } from "../ObservationsPanel";

const ACCENT_BUTTON =
  "rounded-full bg-[var(--brand-accent)] text-white transition hover:opacity-90 disabled:opacity-50";

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
export default async function BrandPage({
  searchParams,
}: {
  searchParams: Promise<{ focus?: string }>;
}) {
  const { store, role } = await requireStorePageAccess(PERMISSIONS.STORE_MANAGE);
  const canReviewApprovals = hasPermission(role, PERMISSIONS.ANALYTICS_VIEW);
  const [pendingApprovals, rawObservations] = await Promise.all([
    canReviewApprovals ? getPendingApprovals(store.id) : Promise.resolve([]),
    // Real GenesisObservation rows (Red/Purple) whose own actionHref points
    // directly at this page — the same real data Live Intelligence/the nav
    // badges already use, just filtered to this one destination.
    prisma.genesisObservation.findMany({
      where: { storeId: store.id, status: "ACTIVE", actionHref: "/dashboard/brand" },
      select: { dedupeKey: true, genesisState: true, summary: true },
    }),
  ]);
  const brandObservations = [...rawObservations].sort(compareObservationPriority);
  const identityApprovals = pendingApprovals.filter(
    (a) => a.actionType === "update_brand_identity" || a.actionType === "update_store_identity"
  );
  // Contextual deep-linking: identityApprovals is already scoped to this
  // store, this section's action types, and PENDING_APPROVAL only — so a
  // match here is automatically valid; anything invalid/stale/resolved/
  // mismatched simply doesn't match and highlightId stays undefined. Same
  // reasoning for brandObservations, already scoped to this page.
  const { focus } = await searchParams;
  const highlightId = focus && identityApprovals.some((a) => a.id === focus) ? focus : undefined;
  const highlightObservationId =
    focus && brandObservations.some((o) => o.dedupeKey === focus) ? focus : undefined;

  const brandIdentity = (store.blueprint as BlueprintContextSubset | null)?.brandIdentity;

  return (
    <div className="min-h-screen p-8 lg:min-h-0">
      <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">Brand</h1>
      <p className="mt-2 max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
        Who your business is — the identity every part of your presence draws from.
      </p>

      {/* Real GenesisObservation rows (Red/Purple) — separate from the
          approval surface below; observations have no Approve/Reject, they
          resolve automatically when the real condition stops being true. */}
      {brandObservations.length > 0 && (
        <>
          <h2 className="mt-6 text-lg font-semibold text-black dark:text-zinc-50">
            Genesis noticed ({brandObservations.length})
          </h2>
          <ObservationsPanel observations={brandObservations} highlightId={highlightObservationId} />
        </>
      )}

      {identityApprovals.length > 0 && (
        <>
          <h2 className="mt-8 text-lg font-semibold text-black dark:text-zinc-50">
            Awaiting Your Approval ({identityApprovals.length})
          </h2>
          <ApprovalRequestsPanel
            approvals={identityApprovals}
            approveAction={approveGenesisAction}
            rejectAction={rejectGenesisAction}
            regenerateAction={regenerateApprovalImage}
            highlightId={highlightId}
          />
        </>
      )}

      <h2 className="mt-8 text-lg font-semibold text-black dark:text-zinc-50">Business identity</h2>
      <form action={editStore} className="mt-4 flex max-w-md flex-col gap-4">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">
            {FIELD_LABELS.name}
          </label>
          <input
            name="name"
            type="text"
            defaultValue={store.name}
            required
            className="rounded-lg border border-black/[.08] px-4 py-2 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">
            {FIELD_LABELS.tagline}
          </label>
          <p className="text-sm text-black dark:text-zinc-50">{store.tagline || "Not set yet"}</p>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">
            {FIELD_LABELS.description}
          </label>
          <textarea
            name="description"
            defaultValue={store.description ?? ""}
            placeholder="Description (optional)"
            rows={3}
            className="rounded-lg border border-black/[.08] px-4 py-2 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
          />
        </div>
        <SubmitButton pendingText="Saving..." className={`mt-2 self-start px-5 py-2 ${ACCENT_BUTTON}`}>
          Save
        </SubmitButton>
      </form>

      <h2 className="mt-10 text-lg font-semibold text-black dark:text-zinc-50">Brand identity</h2>
      <p className="mt-2 max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
        Generated by Genesis, refined through conversation — this is what shapes tone, voice, and design across your business.
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
    </div>
  );
}
