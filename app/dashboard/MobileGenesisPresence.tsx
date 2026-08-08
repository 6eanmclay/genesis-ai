import { deriveAssessmentState, GENESIS_STATE_META } from "@/lib/dashboard/genesisState";
import { GENESIS_ATMOSPHERE } from "@/lib/dashboard/genesisAtmosphere";
import {
  buildBriefing,
  type FocusableApprovalBrief,
  type LiveObservationBrief,
  type CuriosityBrief,
} from "@/lib/dashboard/genesisBriefing";
import { GenesisGreeting } from "./GenesisGreeting";
import { GenesisAvatar } from "./GenesisAvatar";
import { GENESIS_AVATAR_SIZE } from "@/lib/dashboard/genesisAvatarSize";

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
  const briefing = buildBriefing({ focusableApprovals, liveObservations, curiosityItems });
  const briefingText = ownerBriefingSummary
    ? ownerBriefingSummary
    : briefing
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
          20-30% range asked for). GenesisAvatar owns its own glow/activity
          animation now — see that file's own comment.
          Visual polish (2026-08-08) — the avatar no longer recolors for
          state (Sean: calm, consistent, recognizable every time); the
          corner dot below carries the same real signal instead, only
          shown when there's actually something to it (idle shows nothing,
          matching Peace being "nothing needs you right now"). */}
      <div className="relative h-11 w-11 shrink-0">
        <GenesisAvatar className={GENESIS_AVATAR_SIZE.presence} />
        {state !== "idle" && (
          <span
            className={`absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full ${GENESIS_STATE_META[state].dotClassName}`}
            style={{ boxShadow: `0 0 0 2px ${GENESIS_ATMOSPHERE.bg}` }}
            aria-label={GENESIS_STATE_META[state].label}
            title={GENESIS_STATE_META[state].label}
          />
        )}
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
