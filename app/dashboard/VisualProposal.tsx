// The generic, kind-agnostic shell for every visual proposal Genesis makes
// about the storefront — current vs. proposed, shown, not described, then a
// decision. `current`/`proposed` are plain ReactNode slots deliberately, so
// a future proposal kind (a theme/color comparison, a layout comparison,
// eventually a whole-page mock) reuses this exact wrapper by supplying a
// different visual — never a new wrapper. `update_hero` is the first
// concrete visual (see HeroMock.tsx), not the only one this is built for.
//
// The approval framework underneath (ApprovalRequest, approveGenesisAction/
// rejectGenesisAction) is unchanged — this only changes what the merchant
// sees around it: an idea Genesis is sharing, not a technical approval
// queue.
export function VisualProposal({
  title,
  summary,
  current,
  proposed,
  approvalId,
  approveAction,
  rejectAction,
  stacked,
  note,
  highlighted,
}: {
  title: string;
  summary: string;
  current: React.ReactNode;
  proposed: React.ReactNode;
  approvalId: string;
  approveAction: (id: string) => Promise<void>;
  rejectAction: (id: string) => Promise<void>;
  // Side-by-side columns work for compact mocks (HeroMock) but cramp a
  // full real-page preview (Phase 3B's section-order comparison) — stacked
  // gives each its own full-width row instead. Omitted/false preserves
  // every existing caller's layout exactly.
  stacked?: boolean;
  // A small supporting line between the summary and the current/proposed
  // content — e.g. a plain-text order diff. Secondary to the visual
  // comparison above it, never the primary evidence.
  note?: React.ReactNode;
  // Contextual-review connection layer: the one proposal Genesis brought
  // the owner here to review (via "?focus="). Omitted/false preserves
  // every existing caller's appearance exactly.
  highlighted?: boolean;
}) {
  return (
    <div
      className={`mt-4 max-w-2xl rounded-2xl border bg-[var(--brand-accent)]/[0.035] px-5 py-4 ${
        highlighted
          ? "border-[var(--brand-accent)] ring-1 ring-[var(--brand-accent)]"
          : "border-[var(--brand-accent)]/15"
      }`}
    >
      {highlighted && (
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--brand-accent)]">
          Genesis brought you here to review this
        </p>
      )}
      <p className="text-sm font-medium text-black dark:text-zinc-50">{title}</p>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{summary}</p>
      {note && <p className="mt-2 text-xs text-zinc-500">{note}</p>}

      <div className={`mt-4 grid grid-cols-1 gap-4 ${stacked ? "" : "sm:grid-cols-2"}`}>
        <div>
          <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-zinc-500">Current</p>
          {current}
        </div>
        <div>
          <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-[var(--brand-accent,#2563eb)]">
            Genesis&apos;s idea
          </p>
          {proposed}
        </div>
      </div>

      <div className="mt-4 flex gap-2">
        <form action={approveAction.bind(null, approvalId)}>
          <button
            type="submit"
            className="rounded-full bg-[var(--brand-accent,var(--foreground))] px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90"
          >
            Use this
          </button>
        </form>
        <form action={rejectAction.bind(null, approvalId)}>
          <button
            type="submit"
            className="rounded-full border border-black/[.08] px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-black/[.03] dark:border-white/[.145] dark:text-zinc-300 dark:hover:bg-white/[.05]"
          >
            Keep current
          </button>
        </form>
      </div>
    </div>
  );
}
