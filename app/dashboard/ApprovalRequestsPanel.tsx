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

export function ApprovalRequestsPanel({
  approvals,
  approveAction,
  rejectAction,
  regenerateAction,
}: {
  approvals: PendingApproval[];
  approveAction: (id: string) => Promise<void>;
  rejectAction: (id: string) => Promise<void>;
  regenerateAction: (id: string) => Promise<void>;
}) {
  if (approvals.length === 0) {
    return null;
  }

  return (
    <ul className="mt-4 flex max-w-md flex-col gap-2">
      {approvals.map((approval) => {
        const isImageAction = approval.actionType === "update_product_image";
        const diffKeys = Object.keys(approval.input).filter((key) => !HIDDEN_DIFF_KEYS.has(key));

        return (
          <li
            key={approval.id}
            className="rounded-lg border border-black/[.08] px-3 py-2 dark:border-white/[.145]"
          >
            <p className="text-sm text-black dark:text-zinc-50">{approval.summary}</p>
            {approval.lastFailedExecutionId && (
              <p className="mt-1 text-xs text-amber-600 dark:text-amber-500">
                Genesis couldn&apos;t apply this last time
                {approval.lastFailureMessage ? `: ${approval.lastFailureMessage}` : ""} — try again.
              </p>
            )}

            <details className="mt-1.5">
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
                        {String(previous ?? "(empty)")}
                      </dd>
                      <dd className="mt-0.5 text-black dark:text-zinc-50">
                        {String(proposed ?? "")}
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
                  className="rounded-full bg-[var(--brand-accent,var(--foreground))] px-2.5 py-1 text-xs font-medium text-white transition-opacity hover:opacity-90"
                >
                  Approve
                </button>
              </form>
              <form action={rejectAction.bind(null, approval.id)}>
                <button
                  type="submit"
                  className="rounded-full border border-black/[.08] px-2.5 py-1 text-xs font-medium text-zinc-600 hover:bg-black/[.03] dark:border-white/[.145] dark:text-zinc-300 dark:hover:bg-white/[.05]"
                >
                  Reject
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
      })}
    </ul>
  );
}
