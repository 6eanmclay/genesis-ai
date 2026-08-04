import { ActionDiffRows } from "@/lib/execution/ActionDiff";
import type { NextBestAction } from "@/lib/intelligence/nextBestAction";

// Growth Engine M3 — the real center of Home (VISION.md Chapter 1). The
// experience shifting from "What would you like to do today?" to "Here's
// what I noticed": this renders first, before anything else on the page,
// so the owner's first real read of the dashboard is J4's own single
// highest-confidence observation, not a number or a flat list. Everything
// else on Home (today's numbers, Needs your attention, Discovery, Business
// Journey, recent orders, Recently) stays exactly as it is, simply
// reordered to follow this — real, supporting detail underneath the one
// thing that now leads, not rebuilt.
//
// A plain Server Component, matching ApprovalRequestsPanel.tsx's own
// established shape (redirect-based <form> actions, no client state) —
// reuses, not reinvents: ActionDiffRows for the generic diff (the exact
// same rendering the Meeting with J4 and the dashboard's own approvals
// panel already use), and the *existing* approveGenesisAction/
// rejectGenesisAction server actions — no new approve/decline mechanism.
//
// "Alive and personal" comes from voice, not a second avatar instance —
// GenesisDomicile/LiveIntelligence already render Genesis's living
// presence in the shell chrome on every dashboard page; this is that same
// presence speaking, in the same first-person, grounded register already
// proven in the Meeting's own Reflect stage. The empty state reuses
// DiscoveryFeed.tsx's own already-established honest-empty-state voice
// verbatim, not new copy invented for this one surface.
export function NextRecommendation({
  storeName,
  recommendation,
  approveAction,
  rejectAction,
}: {
  storeName: string;
  recommendation: NextBestAction | null;
  approveAction: (id: string) => Promise<void>;
  rejectAction: (id: string) => Promise<void>;
}) {
  if (!recommendation) {
    return (
      <div className="max-w-2xl rounded-2xl border border-[var(--brand-accent)]/15 bg-[var(--brand-accent)]/[0.035] px-5 py-4">
        <p className="text-sm text-zinc-700 dark:text-zinc-300">
          I&apos;ve been looking at {storeName} — I didn&apos;t find anything significant today. Your
          business appears to be on track.
        </p>
        <p className="mt-1 text-xs text-zinc-500">Genesis never stops working on your business.</p>
      </div>
    );
  }

  return (
    <div className="max-w-2xl rounded-2xl border-2 border-[var(--brand-accent)]/25 bg-[var(--brand-accent)]/[0.05] p-6">
      <p className="text-xs text-zinc-500">I&apos;ve been looking at {storeName}.</p>
      <p className="mt-1.5 text-lg font-medium text-black dark:text-zinc-50">{recommendation.summary}</p>

      <div className="mt-4 rounded-xl border border-black/[.06] bg-white/60 p-4 dark:border-white/[.08] dark:bg-black/20">
        <ActionDiffRows input={recommendation.input} previousValues={recommendation.previousValues} />
      </div>

      <div className="mt-4 flex gap-3">
        <form action={approveAction.bind(null, recommendation.approvalRequestId)}>
          <button
            type="submit"
            className="rounded-full bg-[var(--brand-accent,var(--foreground))] px-4 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90"
          >
            Yes, let&apos;s do it
          </button>
        </form>
        <form action={rejectAction.bind(null, recommendation.approvalRequestId)}>
          <button
            type="submit"
            className="rounded-full border border-black/[.08] px-4 py-1.5 text-sm text-zinc-600 hover:bg-black/[.03] dark:border-white/[.145] dark:text-zinc-300 dark:hover:bg-white/[.05]"
          >
            Not right now
          </button>
        </form>
      </div>
    </div>
  );
}
