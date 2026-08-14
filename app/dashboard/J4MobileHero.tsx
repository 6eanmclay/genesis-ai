import { J4_VOICE } from "@/lib/dashboard/j4Voice";
import {
  presenceBriefingText,
} from "./MobileGenesisPresence";
import type {
  FocusableApprovalBrief,
  LiveObservationBrief,
  CuriosityBrief,
} from "@/lib/dashboard/genesisBriefing";

// What J4 noticed, on business home (2026-08-12, gutted 2026-08-14).
//
// This was the J4 hero: a large avatar, his name at 32px, and an "Ask J4
// anything" field — J4 made literally the first and largest thing on the one
// screen an owner opens by default.
//
// J4's persistent presence now sits on every page, including this one, with
// its own orb and its own field. So the hero was showing a second J4 above the
// first, and duplicating the composer next to the real one. Sean's rule:
// "don't duplicate a giant J4 presence on Overview if the persistent J4
// presence already exists there."
//
// What survives is the only part the presence does not already carry: J4's
// own sentence about what he noticed while the owner was away. That is
// content, not presence, and it is the daily briefing this screen exists to
// deliver. The avatar, the name and the field are deleted rather than shrunk,
// for the same reason the business-area icon grid and the permanent
// observation cards were deleted before them: the fix for two of something is
// one of them, never a smaller second one.
export function J4MobileHero({
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
}) {
  // Same real sentence the presence bar speaks everywhere else — shared, not
  // recomputed, so the two can't disagree about the same business.
  const briefingText = presenceBriefingText({
    focusableApprovals,
    liveObservations,
    curiosityItems,
    ownerBriefingSummary,
    justArrived,
  });

  return (
    <div className="md:hidden px-5 pb-1 pt-2">
      {/* J4's own words, so J4's own voice — see lib/dashboard/j4Voice.ts for
          why this treatment stops here and never reaches the chrome. */}
      <p className={`text-[15px] leading-snug text-zinc-600 dark:text-zinc-300 ${J4_VOICE}`}>
        {briefingText}
      </p>
    </div>
  );
}
