import { startTaskConversation } from "./ai-actions";

// BUSINESS_ASSETS_ARCHITECTURE.md M2 — a task card no longer just navigates
// (M1's actionHref Link) — clicking it seeds a real conversation via
// startTaskConversation and opens directly into it. currentPath is
// hardcoded to "/dashboard" because this component only renders on the Home
// page today; would need to become a real prop if TaskCards ever renders
// elsewhere.
export interface TaskCardData {
  id: string;
  title: string;
  summary: string;
}

export function TaskCards({ tasks }: { tasks: TaskCardData[] }) {
  if (tasks.length === 0) {
    return null;
  }
  return (
    <div className="mt-6 max-w-2xl">
      <p className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">Tasks</p>
      <div className="mt-2 flex flex-col gap-2">
        {tasks.map((task) => (
          <form key={task.id} action={startTaskConversation}>
            <input type="hidden" name="taskId" value={task.id} />
            <input type="hidden" name="currentPath" value="/dashboard" />
            <button
              type="submit"
              className="w-full rounded-xl border border-black/[.08] bg-white p-4 text-left transition-colors hover:bg-black/[.02] dark:border-white/[.1] dark:bg-zinc-950 dark:hover:bg-white/[.03]"
            >
              <p className="text-sm font-medium text-black dark:text-zinc-50">{task.title}</p>
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{task.summary}</p>
              <p className="mt-2 text-xs font-medium text-[var(--brand-accent,#2563eb)]">Continue with J4 →</p>
            </button>
          </form>
        ))}
      </div>
    </div>
  );
}
