"use client";

import Image from "next/image";
import { GENESIS_ATMOSPHERE } from "@/lib/dashboard/genesisAtmosphere";
import { GENESIS_STATE_META, type GenesisState } from "@/lib/dashboard/genesisState";

// Mobile's own arrival mechanism (see memory
// project_arrival_experience_milestone.md — "mobile: full-screen, because
// Genesis genuinely is the app there"). Shared by both scenarios
// (first-time creation and returning-user) — this component owns only the
// full-screen presentation (icon, glow, one line of text, a fade-out on
// completion); it has no opinion about *why* the text is what it is or how
// long each line should stay up. That sequencing lives in the caller
// (arrivalBeats.ts for fixed known lines, real /api/draft-status polling
// for creation's phase-tied narration) — keeping this component reusable
// regardless of which drives it.
export function MobileArrivalOverlay({
  text,
  state = "idle",
  leaving = false,
  onSkip,
}: {
  text: string;
  // Real current Genesis Language state — drives the same glow hue/
  // intensity every other surface uses. Defaults to Peace (idle): neither
  // scenario has a real "problem" to report during arrival itself.
  state?: GenesisState;
  // True during the final hand-off — fades the overlay out so the real
  // shell underneath (already rendering) becomes visible. A CSS transition,
  // not an unmount race: the caller keeps this mounted through the fade,
  // then removes it once the transition's own duration has elapsed.
  leaving?: boolean;
  // Returning-user arrival only — never shown during creation, which has
  // real work happening and nothing honest to skip to yet.
  onSkip?: () => void;
}) {
  const meta = GENESIS_STATE_META[state];

  return (
    <div
      className={`fixed inset-0 z-[100] flex flex-col items-center justify-center gap-6 px-8 text-center transition-opacity duration-700 md:hidden ${
        leaving ? "pointer-events-none opacity-0" : "opacity-100"
      }`}
      style={{ backgroundColor: GENESIS_ATMOSPHERE.bg }}
    >
      <div className="relative flex h-24 w-24 items-center justify-center">
        <div
          aria-hidden="true"
          className="absolute inset-[-16px] rounded-full blur-xl transition-colors duration-700"
          style={{ backgroundColor: meta.glowColor, opacity: 0.55 }}
        />
        <Image
          src="/brand/genesis-j4-avatar.png"
          alt="Genesis"
          width={96}
          height={96}
          className="relative rounded-2xl"
          priority
        />
      </div>
      <p
        className="max-w-xs text-lg font-medium"
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
