import { PERMISSIONS, hasPermission, requireStorePageAccess } from "@/lib/permissions";
import { getPendingApprovals } from "@/lib/dashboard/pendingApprovals";
import { editStore } from "../actions";
import { approveGenesisAction, rejectGenesisAction, regenerateApprovalImage } from "../ai-actions";
import { SubmitButton } from "../SubmitButton";
import { ApprovalRequestsPanel } from "../ApprovalRequestsPanel";

const ACCENT_BUTTON =
  "rounded-full bg-[var(--brand-accent)] text-white transition hover:opacity-90 disabled:opacity-50";

// update_brand_identity/update_store_identity render here today purely
// because this is where store-identity editing already lives — a
// temporary presentation choice, not a permanent home for approvals (see
// lib/execution/genesisActions.ts's ACTION_SECTIONS comment).
export default async function SettingsPage() {
  const { store, role } = await requireStorePageAccess(PERMISSIONS.STORE_MANAGE);
  const canReviewApprovals = hasPermission(role, PERMISSIONS.ANALYTICS_VIEW);
  const pendingApprovals = canReviewApprovals ? await getPendingApprovals(store.id) : [];
  const identityApprovals = pendingApprovals.filter(
    (a) => a.actionType === "update_brand_identity" || a.actionType === "update_store_identity"
  );

  return (
    <div className="min-h-screen p-8">
      <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">Settings</h1>

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
          />
        </>
      )}

      <h2 className="mt-8 text-lg font-semibold text-black dark:text-zinc-50">Store info</h2>
      <form action={editStore} className="mt-4 flex max-w-md flex-col gap-4">
        <input
          name="name"
          type="text"
          defaultValue={store.name}
          required
          className="rounded-lg border border-black/[.08] px-4 py-2 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
        />
        <textarea
          name="description"
          defaultValue={store.description ?? ""}
          placeholder="Description (optional)"
          rows={3}
          className="rounded-lg border border-black/[.08] px-4 py-2 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
        />
        <SubmitButton pendingText="Saving..." className={`mt-2 self-start px-5 py-2 ${ACCENT_BUTTON}`}>
          Save store info
        </SubmitButton>
      </form>
    </div>
  );
}
