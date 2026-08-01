// The Genesis Language, v2 (see memory project_genesis_language_model.md) —
// the assessment layer: every real conclusion Genesis reaches resolves, at
// the moment it's formed, to exactly one of these five states via a fixed,
// closed mapping. Computed once, UI-agnostic, never re-derived per screen.
// Consumers should branch on this value and its priority order, never
// recompute their own from raw booleans.
//
// "working" (blue, formerly a sixth peer state) is deliberately NOT part of
// this union — it's a mechanical "a request is in flight" signal, not a
// business judgment, and must never suppress or outrank a real assessment.
// It's now a separate, additive `isWorking` overlay (see StateDot in
// GenesisAssistant.tsx) rendered on top of whichever real state is showing,
// never a state of its own.
export type GenesisState =
  | "idle" // Peace — no active non-Peace assessment for this scope
  | "curiosity" // Curiosity — an active explanation-kind CognitiveOutput
  | "needs_decision" // Responsibility — at least one real ApprovalRequest is pending
  | "opportunity" // Optimism — a real, deduplicated opportunity GenesisObservation exists
  | "urgent"; // Concern — a real, deduplicated operational anomaly needs the owner, never routine setup state

// Pure assessment — computed once from real, already-fetched signals, never
// aware of isWorking (a separate, orthogonal concern layered on top by
// callers that need it; see StateDot). Priority order, per the frozen
// model: a genuine problem outranks a decision outranks a positive
// opportunity outranks mere curiosity outranks nothing.
export function deriveAssessmentState(signals: {
  hasUrgentIssue: boolean;
  hasPendingDecision: boolean;
  hasOpportunity: boolean;
  hasCuriosity: boolean;
}): GenesisState {
  if (signals.hasUrgentIssue) return "urgent";
  if (signals.hasPendingDecision) return "needs_decision";
  if (signals.hasOpportunity) return "opportunity";
  if (signals.hasCuriosity) return "curiosity";
  return "idle";
}

// The single source of truth for how a GenesisState becomes a color/label —
// consumed by GenesisAssistant's dot, the Genesis Domicile, Live
// Intelligence, the Genesis Language legend, DashboardShell's nav pills, and
// ObservationsPanel, so none of them can drift into independently
// hand-copied palettes (a real drift that existed before this pass — see
// the retrofit plan). Labels and descriptions are the frozen Genesis
// Language vocabulary, in Genesis's own voice (never internal state keys).
// `glowColor` is the same hue as `dotClassName`, as a raw value — needed
// anywhere a flat Tailwind background class can't express what's wanted
// (gradients, box-shadow glows in GenesisDomicile's atmospheric orb), kept
// in this same entry rather than a second map so the two can't drift apart.
export const GENESIS_STATE_META: Record<
  GenesisState,
  { label: string; dotClassName: string; glowColor: string; description: string }
> = {
  idle: {
    label: "Peace",
    dotClassName: "bg-zinc-300 dark:bg-zinc-600",
    glowColor: "#a1a1aa",
    description: "Nothing needs you right now — everything is under control.",
  },
  curiosity: {
    label: "Curiosity",
    dotClassName: "bg-teal-400",
    glowColor: "#2dd4bf",
    description: "Genesis found something worth understanding.",
  },
  needs_decision: {
    label: "Responsibility",
    dotClassName: "bg-amber-400",
    glowColor: "#fbbf24",
    description: "A real proposal is waiting on your decision.",
  },
  opportunity: {
    label: "Optimism",
    dotClassName: "bg-purple-500",
    glowColor: "#a855f7",
    description: "Genesis found a genuine opportunity here.",
  },
  urgent: {
    label: "Concern",
    dotClassName: "animate-pulse bg-red-500",
    glowColor: "#ef4444",
    description: "Genesis found something that materially affects the business.",
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
