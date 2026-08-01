import { deriveAssessmentState, GENESIS_STATE_META } from "@/lib/dashboard/genesisState";
import { GENESIS_ATMOSPHERE } from "@/lib/dashboard/genesisAtmosphere";
import { GenesisAvatar } from "./GenesisAvatar";

// Genesis's persistent visual presence in the left rail — lg:+ only (see
// DashboardShell.tsx), always the atmospheric treatment regardless of the
// owner's light/dark toggle (this is Genesis's own identity, not the app's
// dark mode). Not a widget contained inside a card: no border/background
// box around it, just the presence occupying the column's own space.
//
// The static J4 PNG (and its separate hand-built glow wash + the old,
// structurally-unwired isWorking blue-pulse overlay) has been replaced by
// GenesisAvatar (see that file's own comment) — a code-built, animated
// core for Beta. isWorking is no longer a prop here: GenesisAvatar reads
// real conversational activity itself from lib/dashboard/genesisActivity.ts,
// the same real signal, just no longer requiring prop-drilling from a form
// this component has no relationship to.
export function GenesisDomicile({
  hasUrgentIssue,
  hasPendingDecision,
  hasOpportunity,
  hasCuriosity,
  dormant = false,
}: {
  hasUrgentIssue: boolean;
  hasPendingDecision: boolean;
  hasOpportunity: boolean;
  hasCuriosity: boolean;
  // Arrival Experience V1, returning-user desktop "wake the office" (see
  // memory project_arrival_experience_milestone.md). True only for the
  // brief moment right after a real fresh launch, before DashboardShell
  // flips it back to false — a plain opacity transition on the whole
  // presence, quieter than even idle Peace, so "waking" reads as a real
  // transition rather than being indistinguishable from an ordinary page
  // load. Never blocks anything — the real page is already rendered
  // underneath this the whole time.
  dormant?: boolean;
}) {
  const state = deriveAssessmentState({
    hasUrgentIssue,
    hasPendingDecision,
    hasOpportunity,
    hasCuriosity,
  });
  const meta = GENESIS_STATE_META[state];

  return (
    <div
      className={`flex w-full flex-col items-center pt-2 text-center transition-opacity duration-1000 ${
        dormant ? "opacity-40" : "opacity-100"
      }`}
    >
      <div className="relative flex w-full items-center justify-center">
        <GenesisAvatar state={state} className="aspect-square w-[78%]" />
      </div>
      <p
        className="mt-8 font-[var(--font-heading,inherit)] text-2xl font-semibold"
        style={{ color: GENESIS_ATMOSPHERE.text }}
      >
        Genesis
      </p>
      <p className="mt-1 text-sm" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
        {meta.label}
      </p>
    </div>
  );
}
