// The durable "what is Genesis doing right now" abstraction behind every
// visual expression of the Genesis Language — today a colored dot on the
// chat pill, later the full G-ring visual. Consumers should branch on this
// value and its priority order, never recompute their own from raw
// booleans, so a future richer visual only has to change how a state is
// rendered, not how it's decided.
export type GenesisState =
  | "idle" // WHITE — available, nothing to report
  | "working" // BLUE — a real request is in flight right now
  | "needs_decision" // YELLOW — at least one real ApprovalRequest is pending
  | "opportunity" // PURPLE — a real, deduplicated GenesisObservation exists (see lib/dashboard/genesisObservations.ts)
  | "urgent"; // RED — a real, deduplicated operational anomaly needs the owner, never routine setup state

// isWorking can only ever be known from React's useFormStatus(), which only
// works inside the <form> tree it belongs to — it can't be computed once
// and passed down as a prop. So this gets called from more than one place
// (see GenesisAssistant.tsx), but every call site shares this one priority
// rule, confirmed in the Phase 4 plan: a genuine blocker outranks
// everything; "working" is transient, real-time feedback that outranks the
// two durable states; a concrete decision waiting is more actionable than
// an idea Genesis merely noticed.
export function deriveGenesisState(signals: {
  isWorking: boolean;
  hasUrgentIssue: boolean;
  hasPendingDecision: boolean;
  hasOpportunity: boolean;
}): GenesisState {
  if (signals.hasUrgentIssue) return "urgent";
  if (signals.isWorking) return "working";
  if (signals.hasPendingDecision) return "needs_decision";
  if (signals.hasOpportunity) return "opportunity";
  return "idle";
}

// The single source of truth for how a GenesisState becomes a color/label —
// consumed by GenesisAssistant's dot, the Genesis Domicile, and the Genesis
// Language legend, so all three can never drift into three independently
// hand-copied palettes. Labels are the owner-facing words (confirmed
// against the reference composition), not the internal state keys above.
// `glowColor` is the same hue as `dotClassName`, as a raw value — needed
// anywhere a flat Tailwind background class can't express what's wanted
// (gradients, box-shadow glows in GenesisDomicile's atmospheric orb), kept
// in this same entry rather than a second map so the two can't drift apart.
export const GENESIS_STATE_META: Record<
  GenesisState,
  { label: string; dotClassName: string; glowColor: string; description: string }
> = {
  idle: {
    label: "Available",
    dotClassName: "bg-zinc-300 dark:bg-zinc-600",
    glowColor: "#a1a1aa",
    description: "Nothing needs you right now — Genesis is watching.",
  },
  working: {
    label: "Working",
    dotClassName: "animate-pulse bg-blue-500",
    glowColor: "#3b82f6",
    description: "Genesis is actively handling a request.",
  },
  needs_decision: {
    label: "Decision",
    dotClassName: "bg-amber-400",
    glowColor: "#fbbf24",
    description: "A real proposal is waiting on your approval.",
  },
  opportunity: {
    label: "Opportunity",
    dotClassName: "bg-purple-500",
    glowColor: "#a855f7",
    description: "Genesis noticed something worth considering.",
  },
  urgent: {
    label: "Important",
    dotClassName: "animate-pulse bg-red-500",
    glowColor: "#ef4444",
    description: "Something needs your attention now.",
  },
};

// GenesisObservation rows are only ever "urgent" or "opportunity" (see
// lib/dashboard/genesisObservations.ts) — this is the one shared ordering
// for that subset, reused everywhere a list of observations needs urgent
// items shown before opportunity ones (layout.tsx's per-section nav state,
// and each of website/products/brand's own ObservationsPanel query), so the
// same real priority rule isn't hand-copied at each call site.
export function compareObservationPriority(
  a: { genesisState: string },
  b: { genesisState: string }
): number {
  const rank = (state: string) => (state === "urgent" ? 0 : 1);
  return rank(a.genesisState) - rank(b.genesisState);
}
