import { deriveGenesisState, GENESIS_STATE_META } from "@/lib/dashboard/genesisState";
import { GENESIS_ATMOSPHERE } from "@/lib/dashboard/genesisAtmosphere";

// Genesis's persistent visual presence in the left rail — lg:+ only (see
// DashboardShell.tsx), always the atmospheric treatment regardless of the
// owner's light/dark toggle (this is Genesis's own identity, not the
// app's dark mode). Not a widget contained inside a card: no border/
// background box around it, just the presence occupying the column's own
// space. The glow-orb below is still an explicit placeholder — it stands
// in for Genesis's eventual real visual identity (final art direction is
// a separate pass), evolved from a flat colored circle into a soft,
// atmospheric glow (an outer blurred wash + a smaller gradient-lit core)
// so the shell is validated against genuine presence and scale, not a
// small temporary indicator. Still colored from the current GenesisState
// (GENESIS_STATE_META's glowColor) so the state-communication function is
// preserved, not lost in the atmosphere. "working" is intentionally not
// reflected here (it's only knowable inside GenesisAssistant's own
// <form>, see GenesisStatusDot there) — same documented limitation
// LiveIntelligence shares.
export function GenesisDomicile({
  hasUrgentIssue,
  hasPendingDecision,
  hasOpportunity,
}: {
  hasUrgentIssue: boolean;
  hasPendingDecision: boolean;
  hasOpportunity: boolean;
}) {
  const state = deriveGenesisState({
    isWorking: false,
    hasUrgentIssue,
    hasPendingDecision,
    hasOpportunity,
  });
  const meta = GENESIS_STATE_META[state];

  return (
    <div className="flex w-full flex-col items-center pt-2 text-center">
      <div className="relative flex w-full items-center justify-center">
        {/* Outer atmospheric wash — large, soft, heavily blurred; the
            "luminous edge" quality rather than a sharp shape. */}
        <div
          aria-hidden="true"
          className="absolute aspect-square w-[85%] rounded-full blur-3xl transition-colors"
          style={{ backgroundColor: meta.glowColor, opacity: 0.3 }}
        />
        {/* Core — a smaller, gradient-lit orb with its own soft glow ring,
            evoking the references' luminous horizon without literally
            drawing a planet. */}
        <div
          aria-hidden="true"
          className="relative aspect-square w-[55%] rounded-full transition-colors"
          style={{
            background: `radial-gradient(circle at 35% 30%, ${meta.glowColor}, ${GENESIS_ATMOSPHERE.bgElevated} 75%)`,
            boxShadow: `0 0 60px 10px ${meta.glowColor}55, 0 0 130px 35px ${meta.glowColor}22`,
          }}
        />
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
