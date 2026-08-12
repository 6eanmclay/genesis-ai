import { deriveAssessmentState, GENESIS_STATE_META } from "@/lib/dashboard/genesisState";
import { GENESIS_ATMOSPHERE } from "@/lib/dashboard/genesisAtmosphere";
import { J4_VOICE } from "@/lib/dashboard/j4Voice";
import {
  buildBriefing,
  type FocusableApprovalBrief,
  type LiveObservationBrief,
  type CuriosityBrief,
} from "@/lib/dashboard/genesisBriefing";
import { GenesisGreeting } from "./GenesisGreeting";

// The one real sentence J4 says on mobile, extracted 2026-08-12 so the
// compact presence bar (below) and the home hero (J4MobileHero) can never
// speak differently about the same business state. Same rule this file's own
// comment already set for the desktop/mobile split: one real briefing logic,
// two presentations — never a second, independently invented interpretation.
export function presenceBriefingText({
  focusableApprovals,
  liveObservations,
  curiosityItems,
  ownerBriefingSummary,
  justArrived,
}: {
  focusableApprovals: FocusableApprovalBrief[];
  liveObservations: LiveObservationBrief[];
  curiosityItems: CuriosityBrief[];
  ownerBriefingSummary?: string | null;
  justArrived?: boolean;
}): string {
  if (ownerBriefingSummary) return ownerBriefingSummary;
  const briefing = buildBriefing({ focusableApprovals, liveObservations, curiosityItems });
  if (briefing) {
    return justArrived ? `While you were away — ${briefing.lead}.` : briefing.lead;
  }
  return justArrived
    ? "While you were away, everything ran smoothly."
    : "Everything's running smoothly today.";
}

// Mobile's own persistent Genesis presence — true mobile (<768px) only, see
// DashboardShell.tsx. Below lg:, GenesisDomicile/LiveIntelligence (the
// desktop treatment) don't render at all; this is the mobile equivalent,
// compact and horizontal rather than a full column, but built from the
// exact same real state/briefing logic (deriveAssessmentState,
// GENESIS_STATE_META, buildBriefing) — never a second, independently
// invented mobile-only interpretation of what Genesis is currently focused
// on. Always atmospheric-dark regardless of the owner's light/dark toggle —
// this is Genesis's own identity, not the app's dark mode, the same
// principle already applied to GenesisDomicile/LiveIntelligence at lg:+
// ("the mobile experience should preserve the same visual identity as
// desktop").
export function MobileGenesisPresence({
  hasUrgentIssue,
  hasPendingDecision,
  hasOpportunity,
  hasCuriosity,
  focusableApprovals,
  liveObservations,
  curiosityItems,
  userName,
  justArrived = false,
  ownerBriefingSummary = null,
}: {
  hasUrgentIssue: boolean;
  hasPendingDecision: boolean;
  hasOpportunity: boolean;
  hasCuriosity: boolean;
  focusableApprovals: FocusableApprovalBrief[];
  liveObservations: LiveObservationBrief[];
  curiosityItems: CuriosityBrief[];
  userName: string | null;
  // Arrival Experience — true for a brief real window right after the
  // returning-user ritual's full-screen overlay clears (DashboardShell.tsx).
  // Reframes this same real briefing line as "While you were away" rather
  // than its permanent, ambient framing — Sean's explicit sequencing
  // correction: the briefing is only ever spoken once the owner is
  // genuinely inside, never during the ritual itself.
  justArrived?: boolean;
  // Daily Operating Rhythm — see LiveIntelligence.tsx's own comment on this
  // same prop. Still rendered inside the compact single-line `truncate`
  // treatment below — mobile keeps its existing compact format, just fed
  // by the real composed narrative when one exists.
  ownerBriefingSummary?: string | null;
}) {
  const state = deriveAssessmentState({ hasUrgentIssue, hasPendingDecision, hasOpportunity, hasCuriosity });
  const briefingText = presenceBriefingText({
    focusableApprovals,
    liveObservations,
    curiosityItems,
    ownerBriefingSummary,
    justArrived,
  });

  return (
    <div
      className="fixed inset-x-0 top-0 z-40 flex h-[76px] items-center gap-3 px-4 md:hidden"
      style={{ backgroundColor: GENESIS_ATMOSPHERE.bg, borderBottom: `1px solid ${GENESIS_ATMOSPHERE.border}` }}
    >
      {/* No orb here as of 2026-08-12. J4 now has exactly three
          representations and this was a fourth: the business avatar is the
          business's identity, J4MobileHero is his presence on home, and the
          tab bar's summon control is how you reach him from anywhere. On
          every non-home route this bar's orb sat directly above that summon
          control — two J4s on one screen, which is the duplication this
          design keeps deleting.
          What stays is what only this bar can say: the real state dot and the
          briefing sentence. J4's voice, without a second J4. */}
      {state !== "idle" && (
        <span
          className={`mt-2 h-2 w-2 shrink-0 self-start rounded-full ${GENESIS_STATE_META[state].dotClassName}`}
          aria-label={GENESIS_STATE_META[state].label}
          title={GENESIS_STATE_META[state].label}
        />
      )}
      <div className="min-w-0">
        <GenesisGreeting name={userName} sizeClassName="text-lg font-semibold" />
        {/* Natural-language only — no bare state word ("Curiosity") the way
            Domicile's own label shows one; the briefing sentence already
            communicates the state in Genesis's own voice, which is a
            better fit for this compact format. */}
        <p
          className={`truncate text-[13px] ${J4_VOICE}`}
          style={{ color: GENESIS_ATMOSPHERE.textSecondary }}
        >
          {briefingText}
        </p>
      </div>
    </div>
  );
}
