"use client";

import { GENESIS_ATMOSPHERE } from "@/lib/dashboard/genesisAtmosphere";
import { GenesisAvatar } from "./GenesisAvatar";
import { GENESIS_AVATAR_SIZE } from "@/lib/dashboard/genesisAvatarSize";

// Genesis's full-screen arrival mechanism — formerly MobileArrivalOverlay
// (mobile-only, per the original Arrival Experience design record: "mobile
// is full-screen because Genesis genuinely is the app there; desktop
// never goes full-screen"). Renamed and generalized once that stopped
// being true for the returning-user login moment specifically: with a
// real animated presence now built, Sean asked for the same full-screen
// takeover on desktop too, "one consistent first impression" instead of
// the dashboard appearing immediately with the old static icon still
// showing (see memory project_genesis_avatar_v2.md).
//
// First-time creation's own desktop treatment (CreateBusinessArrival.tsx)
// is a deliberate, separate exception that predates this change and stays
// untouched — a real generation pipeline is running, and a panel inside
// the real page reads better than a full-screen takeover for that specific
// moment. `fullScreenOnDesktop` is how the two call sites diverge without
// forking this component: unset (creation) keeps the original mobile-only
// `md:hidden` behavior; set (the returning-user login moment) drops it.
export function GenesisArrivalOverlay({
  text,
  leaving = false,
  onSkip,
  fullScreenOnDesktop = false,
}: {
  text: string;
  // True during the final hand-off — fades the overlay out so the real
  // shell underneath (already rendering) becomes visible. A CSS transition,
  // not an unmount race: the caller keeps this mounted through the fade,
  // then removes it once the transition's own duration has elapsed.
  leaving?: boolean;
  // Returning-user arrival only — never shown during creation, which has
  // real work happening and nothing honest to skip to yet.
  onSkip?: () => void;
  // See the file-level comment above — false keeps this mobile-only
  // (CreateBusinessArrival's untouched desktop panel exception), true
  // shows it at every viewport (the returning-user login moment).
  fullScreenOnDesktop?: boolean;
}) {
  return (
    <div
      className={`fixed inset-0 z-[100] flex flex-col items-center justify-center gap-8 px-8 text-center transition-opacity duration-[700ms] ${
        fullScreenOnDesktop ? "" : "md:hidden"
      } ${leaving ? "pointer-events-none opacity-0" : "opacity-100"}`}
      style={{ backgroundColor: GENESIS_ATMOSPHERE.bg }}
    >
      {/* "Right now it feels like an icon... the first thing they should
          feel is: I'm entering Genesis." Scales with the viewport (nearly
          spanning it on mobile) but caps well short of dominating a large
          desktop screen. wakeOnMount: this is the one context where Genesis
          should visibly wake up — see GenesisAvatar.tsx. */}
      <GenesisAvatar className={GENESIS_AVATAR_SIZE.arrival} wakeOnMount />
      <p
        className="max-w-sm text-lg font-medium"
        style={{ color: GENESIS_ATMOSPHERE.text }}
      >
        {text}
      </p>
      {onSkip && (
        <button
          type="button"
          onClick={onSkip}
          className="mt-2 text-xs underline"
          style={{ color: GENESIS_ATMOSPHERE.textSecondary }}
        >
          Skip
        </button>
      )}
    </div>
  );
}
