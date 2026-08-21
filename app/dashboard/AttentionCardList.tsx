import { groupAttentionCards, type AttentionCard as AttentionCardData } from "@/lib/dashboard/attentionCards";
import { AttentionCard } from "./AttentionCard";

// "For multiple proposed changes, allow individual approval and, where
// appropriate, Approve All" (Sean, 2026-08-09). The real execution behind
// this — approveGenesisActionGroup — already existed (built for the
// pre-AttentionCard ApprovalRequestsPanel); the real gap was purely
// presentational, named honestly during the Business Portal Phase 1
// consolidation and left for later: this is that later. One shared
// component so every page renders grouped proposals the same way, rather
// than each page inventing its own "Approve All" header.
export function AttentionCardList({
  cards,
  approveAction,
  rejectAction,
  approveGroupAction,
  issueAction,
  discoveryAction,
  taskAction,
  dismissAction,
  economicsAction,
  currentPath,
  highlightId,
  regenerateAction,
}: {
  cards: AttentionCardData[];
  approveAction: (id: string) => Promise<void>;
  rejectAction: (id: string) => Promise<void>;
  approveGroupAction: (groupId: string) => Promise<void>;
  issueAction: (formData: FormData) => void;
  discoveryAction: (formData: FormData) => void;
  taskAction: (formData: FormData) => void;
  dismissAction: (cardId: string, currentPath: string) => Promise<void>;
  /** Only passed by a caller whose tasks can include a supplier question. */
  economicsAction?: (formData: FormData) => void;
  currentPath: string;
  highlightId?: string;
  regenerateAction?: (id: string) => Promise<void>;
}) {
  const groups = groupAttentionCards(cards);

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      {groups.map((group) => (
        <div key={group.groupId ?? group.cards[0].id} className="flex flex-col gap-2.5">
          {/* Grouping is purely presentational — each card underneath
              keeps its own real Approve/Reject regardless. Approve All
              runs the exact same execute()/verify()/record path as a
              single approval, once per member (approveGenesisActionGroup,
              app/dashboard/ai-actions.ts) — never a fabricated combined
              decision. */}
          {group.groupId && group.cards.length > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-xs text-zinc-500 dark:text-zinc-400">{group.cards.length} changes from one idea</p>
              <form action={approveGroupAction.bind(null, group.groupId)}>
                <button
                  type="submit"
                  className="rounded-full bg-[#2563eb] px-3 py-1 text-xs font-medium text-white transition-opacity hover:opacity-90"
                >
                  Approve All {group.cards.length}
                </button>
              </form>
            </div>
          )}
          <div className="flex flex-col gap-2.5">
            {group.cards.map((card) => (
              <AttentionCard
                key={card.id}
                card={card}
                approveAction={approveAction}
                rejectAction={rejectAction}
                issueAction={issueAction}
                discoveryAction={discoveryAction}
                taskAction={taskAction}
                dismissAction={dismissAction}
          economicsAction={economicsAction}
                currentPath={currentPath}
                highlightId={highlightId}
                regenerateAction={regenerateAction}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
