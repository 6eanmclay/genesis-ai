import type { PendingApproval } from "@/lib/dashboard/pendingApprovals";
import { FIELD_LABELS } from "@/lib/execution/genesisActions";

// Plain Server Component — Approve/Reject/Regenerate are simple
// redirect-based forms, same as every dashboard action before Layer 2, no
// client-side state needed. The Current -> Proposed diff is rendered
// generically from the data shape (one row per key in `input`), not
// per-action JSX, so a third registered action type needs no changes here
// — except `productId`, a raw internal id with no user-facing meaning,
// which is deliberately excluded from the generic loop below.
const HIDDEN_DIFF_KEYS = new Set(["productId"]);

// A plain string array (e.g. coreValues, brandKeywords) formatted for one
// diff row — Array.prototype.toString() joins with a bare comma, no space,
// which reads as a bug rather than a list. Everything else still falls
// through to String() unchanged.
function formatDiffValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.length > 0 ? value.join(", ") : "(empty)";
  }
  return String(value ?? "(empty)");
}

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
    const diffKeys = Object.keys(approval.input).filter((key) => !HIDDEN_DIFF_KEYS.has(key));
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
              <dl className="mt-2 flex flex-col gap-2">
                {diffKeys.map((key) => {
                  const previous = approval.previousValues[key];
                  const proposed = approval.input[key];

                  if (key === "imageUrl") {
                    return (
                      <div key={key} className="text-xs">
                        <dt className="font-medium text-zinc-500">{FIELD_LABELS[key] ?? key}</dt>
                        <div className="mt-1 flex gap-2">
                          <div className="flex-1">
                            <p className="mb-1 text-zinc-400">Current</p>
                            {previous && typeof previous === "string" ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={previous}
                                alt="Current product"
                                className="aspect-square w-full rounded-md object-cover"
                              />
                            ) : (
                              <div className="flex aspect-square w-full items-center justify-center rounded-md bg-black/[.03] text-zinc-400 dark:bg-white/[.05]">
                                No image
                              </div>
                            )}
                          </div>
                          <div className="flex-1">
                            <p className="mb-1 text-black dark:text-zinc-50">Proposed</p>
                            {proposed && typeof proposed === "string" ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={proposed}
                                alt="Proposed product"
                                className="aspect-square w-full rounded-md object-cover"
                              />
                            ) : (
                              <div className="flex aspect-square w-full items-center justify-center rounded-md bg-black/[.03] text-zinc-400 dark:bg-white/[.05]">
                                No image
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  }

                  return (
                    <div key={key} className="text-xs">
                      <dt className="font-medium text-zinc-500">{FIELD_LABELS[key] ?? key}</dt>
                      <dd className="mt-0.5 text-zinc-400 line-through">
                        {formatDiffValue(previous)}
                      </dd>
                      <dd className="mt-0.5 text-black dark:text-zinc-50">
                        {formatDiffValue(proposed)}
                      </dd>
                    </div>
                  );
                })}
              </dl>
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
