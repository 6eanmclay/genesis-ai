import { GenesisAvatar } from "./GenesisAvatar";
import { GENESIS_AVATAR_SIZE } from "@/lib/dashboard/genesisAvatarSize";
import { J4Icon } from "./J4Icon";
import { J4_VOICE } from "@/lib/dashboard/j4Voice";
import {
  presenceBriefingText,
} from "./MobileGenesisPresence";
import type {
  FocusableApprovalBrief,
  LiveObservationBrief,
  CuriosityBrief,
} from "@/lib/dashboard/genesisBriefing";

// The J4 hero (2026-08-12) — business home only, mobile only. The approved
// interface direction's central claim, made literal: J4 isn't a feature
// inside Genesis, J4 is the interface through which the business is
// operated. So on the one screen an owner opens by default, he is the first
// and largest thing, and everything else arranges itself beneath him.
//
// Three elements, deliberately. Sean's own statement of why each exists:
// J4 says "I'm here"; Ask J4 says "talk to me"; and below this, What J4
// noticed says "I noticed some things while you were away." The empty space
// around them is not a gap waiting to be filled — it is what makes J4 read
// as the center rather than as one widget among many.
//
// The compact MobileGenesisPresence bar is suppressed on this route (see
// DashboardShell) precisely so J4 appears once. Two J4 presences on one
// screen is the same duplication that got the business-area icon grid and
// the permanent observation cards deleted from this design.
export function J4MobileHero({
  focusableApprovals,
  liveObservations,
  curiosityItems,
  ownerBriefingSummary,
  justArrived,
  onSummon,
}: {
  focusableApprovals: FocusableApprovalBrief[];
  liveObservations: LiveObservationBrief[];
  curiosityItems: CuriosityBrief[];
  ownerBriefingSummary?: string | null;
  justArrived?: boolean;
  /** Opens the persistent J4 layer over this workspace. Never navigates. */
  onSummon: () => void;
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
    <div className="md:hidden">
      <div className="flex flex-col items-center px-5 pb-1 pt-2 text-center">
        <GenesisAvatar className={GENESIS_AVATAR_SIZE.sm} />
        <p className="mt-4 text-[32px] font-semibold leading-none tracking-tight text-black dark:text-zinc-50">
          J4
        </p>
        {/* J4's own words, so J4's own voice — see lib/dashboard/j4Voice.ts
            for why this treatment stops here and never reaches the chrome. */}
        <p
          className={`mt-2 max-w-[26rem] text-[14px] leading-snug text-zinc-500 dark:text-zinc-400 ${J4_VOICE}`}
        >
          {briefingText}
        </p>
      </div>

      {/* Not a text input, and not a link either. This summons the same
          persistent J4 layer the tab bar control opens. Nothing navigates, so
          this screen keeps its scroll position and its state underneath, and
          the conversation it opens is the one and only J4 conversation. */}
      <button
        type="button"
        onClick={onSummon}
        aria-haspopup="dialog"
        className="mt-5 flex w-full items-center gap-3 rounded-2xl border border-black/[.09] bg-white px-4 py-3.5 text-left transition-colors active:bg-black/[.03] dark:border-white/[.145] dark:bg-zinc-950 dark:active:bg-white/[.05]"
      >
        <span className="flex-1 text-[15px] text-zinc-400 dark:text-zinc-500">Ask J4 anything…</span>
        <span className="flex h-8 w-8 items-center justify-center rounded-full border border-black/[.09] text-zinc-500 dark:border-white/[.145] dark:text-zinc-400">
          <J4Icon name="add" size={16} />
        </span>
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#2563eb] text-white">
          <J4Icon name="send" size={15} />
        </span>
      </button>
    </div>
  );
}
