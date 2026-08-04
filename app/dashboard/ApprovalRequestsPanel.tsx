import type { PendingApproval } from "@/lib/dashboard/pendingApprovals";
import { ActionDiffRows } from "@/lib/execution/ActionDiff";

// Plain Server Component — Approve/Reject/Regenerate are simple
// redirect-based forms, same as every dashboard action before Layer 2, no
// client-side state needed. The Current -> Proposed diff itself (generic,
// one row per key in `input`) is shared with any future caller — see
// ActionDiffRows (lib/execution/ActionDiff.tsx), Meeting with J4 M2.

export function ApprovalRequestsPanel({
  approvals,
  approveAction,
  rejectAction,
  regenerateAction,
  approveGroupAction,
  highlightId,
}: {
  approvals: PendingApproval[];
  approveAction: (id: string) => Promise<void>;
  rejectAction: (id: string) => Promise<void>;
  regenerateAction: (id: string) => Promise<void>;
  // Executes every still-pending member of a groupId in one action — see
  // approveGenesisActionGroup's own comment for why this exists (grouping
  // was presentational-only before; this is the real batch action). Optional
  // so any caller not yet passing it renders exactly as before (no group
  // action button), rather than crashing.
  approveGroupAction?: (groupId: string) => Promise<void>;
  // Contextual-review connection layer: the one approval, if any, that
  // Genesis brought the owner here to review (via "?focus=") — gets an
  // auto-expanded diff and a visual callout, everything else renders as
  // it always has.
  highlightId?: string;
}) {
  if (approvals.length === 0) {
    return null;
  }

  // Multi-object delegated objectives (e.g. "replace all my product
  // photos") produce several ApprovalRequests sharing one groupId — same
  // grouping Website's own review surface already uses. Grouped here too so
  // the owner sees "Genesis has N related changes from one idea" as a
  // single cluster, never N disconnected cards; every card underneath
  // keeps its own independent Approve/Reject regardless — grouping is
  // presentational only, never a combined decision.
  const groups = new Map<string, PendingApproval[]>();
  for (const approval of approvals) {
    const groupKey = approval.groupId ?? approval.id;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey)!.push(approval);
  }

  const renderRow = (approval: PendingApproval) => {
    const isImageAction = approval.actionType === "update_product_image";
    const isHighlighted = approval.id === highlightId;

    return (
      <li
        key={approval.id}
            className={`rounded-lg border px-3 py-2 ${
              isHighlighted
                ? "border-[var(--brand-accent,var(--foreground))] ring-1 ring-[var(--brand-accent,var(--foreground))]"
                : "border-black/[.08] dark:border-white/[.145]"
            }`}
          >
            {isHighlighted && (
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--brand-accent,var(--foreground))]">
                Genesis brought you here to review this
              </p>
            )}
            <p className="text-sm text-black dark:text-zinc-50">{approval.summary}</p>
            {approval.lastFailedExecutionId && (
              <p className="mt-1 text-xs text-amber-600 dark:text-amber-500">
                Genesis couldn&apos;t apply this last time
                {approval.lastFailureMessage ? `: ${approval.lastFailureMessage}` : ""} — try again.
              </p>
            )}

            <details className="mt-1.5" open={isHighlighted}>
              <summary className="cursor-pointer text-xs text-zinc-500 underline">
                Review changes
              </summary>
              <ActionDiffRows input={approval.input} previousValues={approval.previousValues} />
            </details>

            <div className="mt-2 flex gap-2">
              <form action={approveAction.bind(null, approval.id)}>
                <button
                  type="submit"
                  className="rounded-full bg-foreground px-2.5 py-1 text-xs font-medium text-background transition-opacity hover:opacity-90"
                >
                  Use this
                </button>
              </form>
              <form action={rejectAction.bind(null, approval.id)}>
                <button
                  type="submit"
                  className="rounded-full border border-black/[.08] px-2.5 py-1 text-xs font-medium text-zinc-600 hover:bg-black/[.03] dark:border-white/[.145] dark:text-zinc-300 dark:hover:bg-white/[.05]"
                >
                  Keep current
                </button>
              </form>
              {isImageAction && (
                <form action={regenerateAction.bind(null, approval.id)}>
                  <button
                    type="submit"
                    className="rounded-full border border-black/[.08] px-2.5 py-1 text-xs font-medium text-zinc-600 hover:bg-black/[.03] dark:border-white/[.145] dark:text-zinc-300 dark:hover:bg-white/[.05]"
                  >
                    Regenerate
                  </button>
                </form>
              )}
            </div>
          </li>
    );
  };

  return (
    <ul className="mt-4 flex max-w-md flex-col gap-2">
      {[...groups.entries()].map(([groupKey, group]) =>
        group.length > 1 ? (
          <li key={groupKey} className="rounded-2xl border border-dashed border-[var(--brand-accent)]/25 p-3">
            <div className="flex items-center justify-between gap-2 px-1 pb-2">
              <p className="text-xs font-medium text-zinc-500">
                Genesis has {group.length} related changes from one idea
              </p>
              {approveGroupAction && (
                <form action={approveGroupAction.bind(null, groupKey)}>
                  <button
                    type="submit"
                    className="rounded-full bg-[var(--brand-accent,var(--foreground))] px-2.5 py-1 text-xs font-medium text-white transition-opacity hover:opacity-90"
                  >
                    Use all {group.length}
                  </button>
                </form>
              )}
            </div>
            <ul className="flex flex-col gap-2">{group.map(renderRow)}</ul>
          </li>
        ) : (
          renderRow(group[0])
        )
      )}
    </ul>
  );
}
