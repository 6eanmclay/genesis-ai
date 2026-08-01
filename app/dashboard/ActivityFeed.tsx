import type { ActivityItem } from "@/lib/dashboard/types";
import { STATUS_DOT } from "@/lib/execution/statusDisplay";
import { COGNITIVE_OUTPUT_KIND_LABEL } from "@/lib/dashboard/cognitiveOutputLabels";

const ACTOR_LABEL: Record<ActivityItem["actorType"], string> = {
  USER: "You",
  GENESIS: "Genesis",
  SYSTEM: "System",
};

// Genesis chat turns log their full conversational reply as this same
// `message` field (see recordGenesisExecution calls in ai-actions.ts) —
// fine for an audit trail, but a whole paragraph doesn't belong in a
// glanceable feed. Truncate rather than change what's logged, since other
// action types' messages are already short and human-readable by design.
const MAX_MESSAGE_LENGTH = 100;

function truncate(message: string): string {
  return message.length > MAX_MESSAGE_LENGTH ? `${message.slice(0, MAX_MESSAGE_LENGTH).trimEnd()}…` : message;
}

// Renders only when there's real activity — the caller omits this section
// entirely for a brand-new store rather than showing "No activity yet."
export function ActivityFeed({ items }: { items: ActivityItem[] }) {
  if (items.length === 0) {
    return null;
  }
  return (
    <ul className="flex flex-col divide-y divide-black/[.05] dark:divide-white/[.08]">
      {items.map((item) => (
        <li key={item.id} className="flex items-start gap-2 py-2 first:pt-0">
          <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[item.status]}`} />
          <div>
            {item.cognitiveOutputKind && (
              <p className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">
                {COGNITIVE_OUTPUT_KIND_LABEL[item.cognitiveOutputKind] ?? item.cognitiveOutputKind}
              </p>
            )}
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              {truncate(item.message)}
              {item.decisionMode === "autonomous" && (
                <span className="ml-1.5 text-xs text-zinc-500">
                  — handled automatically, no approval needed
                </span>
              )}
            </p>
            <p className="mt-0.5 text-xs text-zinc-500">
              {ACTOR_LABEL[item.actorType]} — {item.createdAt.toLocaleString()}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}
