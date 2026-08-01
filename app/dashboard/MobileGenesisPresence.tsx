import Image from "next/image";
import { deriveAssessmentState, GENESIS_STATE_META, isStableAttentionState } from "@/lib/dashboard/genesisState";
import { GENESIS_ATMOSPHERE } from "@/lib/dashboard/genesisAtmosphere";
import {
  buildBriefing,
  type FocusableApprovalBrief,
  type LiveObservationBrief,
  type CuriosityBrief,
} from "@/lib/dashboard/genesisBriefing";
import { GenesisGreeting } from "./GenesisGreeting";

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
}) {
  const state = deriveAssessmentState({ hasUrgentIssue, hasPendingDecision, hasOpportunity, hasCuriosity });
  const meta = GENESIS_STATE_META[state];
  const stable = isStableAttentionState(state);
  const briefing = buildBriefing({ focusableApprovals, liveObservations, curiosityItems });
  const briefingText = briefing
    ? justArrived
      ? `While you were away — ${briefing.lead}.`
      : briefing.lead
    : justArrived
      ? "While you were away, everything ran smoothly."
      : "Everything's running smoothly today.";

  return (
    <div
      className="fixed inset-x-0 top-0 z-40 flex h-[76px] items-center gap-3 px-4 md:hidden"
      style={{ backgroundColor: GENESIS_ATMOSPHERE.bg, borderBottom: `1px solid ${GENESIS_ATMOSPHERE.border}` }}
    >
      {/* 44px — up from the old 36px mobile icon (~22% larger, inside the
          20-30% range asked for) — with a blurred halo behind it colored
          and sized by the real current assessment state, never a separate
          invented color. */}
      <div className="relative flex h-11 w-11 shrink-0 items-center justify-center">
        <div
          aria-hidden="true"
          className="absolute inset-[-8px] rounded-full blur-md transition-colors duration-700"
          style={{ backgroundColor: meta.glowColor, opacity: stable ? 0.5 : 0.22 }}
        />
        <Image
          src="/brand/genesis-j4-avatar.png"
          alt="Genesis"
          width={44}
          height={44}
          className="relative rounded-[10px]"
        />
      </div>
      <div className="min-w-0">
        <GenesisGreeting name={userName} sizeClassName="text-lg font-semibold" />
        {/* Natural-language only — no bare state word ("Curiosity") the way
            Domicile's own label shows one; the briefing sentence already
            communicates the state in Genesis's own voice, which is a
            better fit for this compact format. */}
        <p className="truncate text-xs" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
          {briefingText}
        </p>
      </div>
    </div>
  );
}
