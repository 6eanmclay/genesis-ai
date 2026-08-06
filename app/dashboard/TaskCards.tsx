import Link from "next/link";

// BUSINESS_ASSETS_ARCHITECTURE.md M1 — the first real rendering surface for
// the new unified Task model. Deliberately its own section, not merged into
// AttentionPanel's list: AttentionPanel's own comment explains why routine
// incomplete setup was moved out of the Red "Needs your attention" panel
// into BusinessJourney's calmer framing — priority "opportunity" tasks
// belong in that same calm register, never blended with genuine failures.
// Still plain navigation for now (actionHref) — M2 is what makes a card
// open a real, task-aware J4 conversation instead.
export interface TaskCardData {
  id: string;
  title: string;
  summary: string;
  actionHref: string | null;
}

export function TaskCards({ tasks }: { tasks: TaskCardData[] }) {
  if (tasks.length === 0) {
    return null;
  }
  return (
    <div className="mt-6 max-w-2xl">
      <p className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">Tasks</p>
      <div className="mt-2 flex flex-col gap-2">
        {tasks.map((task) => {
          const card = (
            <div className="rounded-xl border border-black/[.08] bg-white p-4 transition-colors hover:bg-black/[.02] dark:border-white/[.1] dark:bg-zinc-950 dark:hover:bg-white/[.03]">
              <p className="text-sm font-medium text-black dark:text-zinc-50">{task.title}</p>
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{task.summary}</p>
            </div>
          );
          return task.actionHref ? (
            <Link key={task.id} href={task.actionHref}>
              {card}
            </Link>
          ) : (
            <div key={task.id}>{card}</div>
          );
        })}
      </div>
    </div>
  );
}
