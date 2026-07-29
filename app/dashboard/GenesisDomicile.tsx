import { deriveGenesisState, GENESIS_STATE_META } from "@/lib/dashboard/genesisState";
import { GENESIS_ATMOSPHERE } from "@/lib/dashboard/genesisAtmosphere";
import { GenesisOrbitRing } from "./GenesisOrbitRing";

// Genesis's persistent visual presence in the left rail — lg:+ only (see
// DashboardShell.tsx), always the atmospheric treatment regardless of the
// owner's light/dark toggle (this is Genesis's own identity, not the app's
// dark mode). Not a widget contained inside a card: no border/background
// box around it, just the presence occupying the column's own space.
//
// Orbit redesign — the glow-orb (a flat filled circle) is retired in favor
// of a Saturn-style ring on a tilted plane, genuinely passing behind and in
// front of a real celestial-body planet — all of that (ring, planet, the
// two have to be interleaved in one stacking order) lives together in
// GenesisOrbitRing now; see its own comment for the full reasoning. This
// component stays responsible for the outer atmospheric wash and the
// wordmark, plus resolving the real GenesisState this whole presence
// reflects. Still an explicit placeholder for Genesis's eventual final
// visual identity — this pass is the interaction/energy language, not
// final artwork.
//
// "working" is real (a chat request genuinely in flight) but today it's
// only knowable inside GenesisAssistant's own <form>, via useFormStatus —
// it can't be computed once and passed down as a prop the way the other
// three signals can (see deriveGenesisState's own comment). This component
// accepts isWorking so it's ready the moment that plumbing exists; every
// current call site simply doesn't pass it yet, which is identical to
// passing false — idle/needs_decision/opportunity/urgent are completely
// unaffected by this addition.
export function GenesisDomicile({
  hasUrgentIssue,
  hasPendingDecision,
  hasOpportunity,
  isWorking = false,
}: {
  hasUrgentIssue: boolean;
  hasPendingDecision: boolean;
  hasOpportunity: boolean;
  isWorking?: boolean;
}) {
  const state = deriveGenesisState({
    isWorking,
    hasUrgentIssue,
    hasPendingDecision,
    hasOpportunity,
  });
  const meta = GENESIS_STATE_META[state];
  // "Stable attention" states (a real decision, opportunity, or urgent
  // issue) render the ring at full intensity — categorically equal weight
  // to each other (this mirrors the existing Genesis Language legend's own
  // flat, non-hierarchical treatment of these three), just different hues.
  // idle and working both get the calmer, thinner base-ring treatment;
  // working additionally gets the chasing highlight described above.
  const isStableAttention = state === "needs_decision" || state === "opportunity" || state === "urgent";

  return (
    <div className="flex w-full flex-col items-center pt-2 text-center">
      <div className="relative flex w-full items-center justify-center">
        {/* Outer atmospheric wash — large, soft, heavily blurred; brighter
            for a stable attention state, dimmer (but never absent) at idle. */}
        <div
          aria-hidden="true"
          className="absolute aspect-square w-[85%] rounded-full blur-3xl transition-colors duration-700"
          style={{
            backgroundColor: meta.glowColor,
            opacity: isStableAttention ? 0.45 : state === "working" ? 0.32 : 0.2,
          }}
        />

        {/* Ring + planet, interleaved (back ring → planet → front ring) —
            client-side (see GenesisOrbitRing's own comment) so it can also
            catch the real "just finished working" transition and give it
            a genuine completion flourish. No text is drawn on it; the ring
            and planet together are the icon. */}
        <GenesisOrbitRing state={state} glowColor={meta.glowColor} isStableAttention={isStableAttention} />
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
