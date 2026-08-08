import Link from "next/link";
import type { AttentionCard as AttentionCardData } from "@/lib/dashboard/attentionCards";
import { ActionDiffRows } from "@/lib/execution/ActionDiff";

// Home Redesign (2026-08-08) — "the dashboard shows the business, J4
// handles the work" (Sean). One shared card language for everything that
// used to be four separate sections (AttentionPanel/ApprovalsSummary/
// DiscoveryFeed/TaskCards) — collapsed by default (a dot, a concise
// summary, one prominent action), the full underlying detail still
// present but tucked behind a native <details> disclosure rather than
// removed. A plain server component throughout (no client state) — real
// <form>/<details> mechanics only, matching ApprovalRequestsPanel.tsx's
// own established shape.
//
// Two action shapes, matching Sean's own explicit distinction: a
// "proposal" card is a fully-specified change J4 already prepared — the
// owner's real choice is yes/no, so it approves directly, right here,
// never routed through a conversation just to say yes. Every other kind
// hands off to a real J4 conversation with the exact originating context
// already seeded in (see startIssueConversation/startDiscoveryConversation/
// startTaskConversation) — the owner never re-explains what they're
// acting on.
export function AttentionCard({
  card,
  approveAction,
  rejectAction,
  issueAction,
  discoveryAction,
  taskAction,
}: {
  card: AttentionCardData;
  approveAction: (id: string) => Promise<void>;
  rejectAction: (id: string) => Promise<void>;
  issueAction: (formData: FormData) => void;
  discoveryAction: (formData: FormData) => void;
  taskAction: (formData: FormData) => void;
}) {
  const hasExpandableDetail =
    card.kind === "proposal" || (card.kind === "task" && card.detail) || card.occurredAt !== null;

  return (
    <div className="rounded-xl border border-[#2563eb]/15 bg-[#2563eb]/[0.035] px-4 py-3">
      <div className="flex items-start gap-2.5">
        <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${card.dotClassName}`} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-sm text-black dark:text-zinc-50">{card.summary}</p>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            {card.kind === "proposal" ? (
              <>
                <form action={approveAction.bind(null, card.approvalRequestId)}>
                  <button
                    type="submit"
                    className="rounded-full bg-[#2563eb] px-3.5 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90"
                  >
                    Approve
                  </button>
                </form>
                <form action={rejectAction.bind(null, card.approvalRequestId)}>
                  <button
                    type="submit"
                    className="rounded-full border border-black/[.08] px-3.5 py-1.5 text-xs text-zinc-600 hover:bg-black/[.03] dark:border-white/[.145] dark:text-zinc-300 dark:hover:bg-white/[.05]"
                  >
                    Not now
                  </button>
                </form>
              </>
            ) : (
              <form
                action={
                  card.kind === "issue"
                    ? issueAction
                    : card.kind === "discovery"
                      ? discoveryAction
                      : taskAction
                }
              >
                {card.kind === "issue" && <input type="hidden" name="message" value={card.message} />}
                {card.kind === "discovery" && <input type="hidden" name="summary" value={card.discoverySummary} />}
                {card.kind === "task" && (
                  <>
                    <input type="hidden" name="taskId" value={card.taskId} />
                    <input type="hidden" name="currentPath" value="/dashboard" />
                  </>
                )}
                <button
                  type="submit"
                  className="rounded-full bg-[#2563eb] px-3.5 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90"
                >
                  Have J4 take care of it
                </button>
              </form>
            )}

            {hasExpandableDetail && (
              <details className="group">
                <summary className="cursor-pointer list-none text-xs text-zinc-500 underline">Details</summary>
                <div className="mt-2 flex flex-col gap-1.5 text-xs text-zinc-500">
                  {card.occurredAt && <p>{card.occurredAt.toLocaleString()}</p>}
                  {card.kind === "task" && card.detail && <p>{card.detail}</p>}
                  {card.kind === "proposal" && (
                    <div className="rounded-lg border border-black/[.06] bg-white/60 p-3 dark:border-white/[.08] dark:bg-black/20">
                      <ActionDiffRows input={card.input} previousValues={card.previousValues} />
                      {card.reviewHref && (
                        <Link href={card.reviewHref} className="mt-2 inline-block font-medium text-[#2563eb] underline">
                          Review in full
                        </Link>
                      )}
                    </div>
                  )}
                </div>
              </details>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
