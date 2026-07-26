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
