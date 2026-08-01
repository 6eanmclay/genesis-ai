"use client";

import { useMemo } from "react";
import { GENESIS_ATMOSPHERE } from "@/lib/dashboard/genesisAtmosphere";
import { useBeatSequence, type Beat } from "@/lib/dashboard/arrivalBeats";
import { MobileArrivalOverlay } from "./MobileArrivalOverlay";
import { GenesisAvatar } from "./GenesisAvatar";

// Real phase status (StoreDraft.status, polled from /api/draft-status —
// see CreateStoreForm.tsx's own comment for why this is polling rather
// than a subscription) mapped to real Genesis narration. Every value here
// is a genuine backend state transition, never a fixed-duration guess —
// the one non-negotiable constraint from the frozen design record.
const PHASE_TEXT: Record<string, string> = {
  generating_primary: "I'm shaping your brand identity and storefront…",
  generating_secondary: "Building your catalog and storefront details…",
  generating_icon: "Creating your business icon…",
};

// First-time creation's arrival (see memory
// project_arrival_experience_milestone.md — "celebrate the birth of the
// business," the one deliberate desktop exception to "never full-screen").
// This component owns only the *narration and completion beat*; the real
// generation/polling loop stays in CreateStoreForm.tsx, unchanged from
// before this milestone — this is a presentational layer on top of it.
export function CreateBusinessArrival({
  userName,
  phase,
  complete,
  storeName,
  onFinished,
}: {
  userName: string | null;
  phase: string | null;
  complete: boolean;
  storeName: string | null;
  onFinished: () => void;
}) {
  const name = userName ? `, ${userName}` : "";
  const completionBeats: Beat[] = useMemo(
    () => [
      { text: `Welcome to Genesis${name}.`, pauseBeforeMs: 600, holdMs: 1600 },
      { text: `${storeName ?? "Your business"} is ready.`, holdMs: 1600 },
      { text: "Let's open your business.", holdMs: 1200 },
    ],
    [name, storeName]
  );

  const { activeBeat, done } = useBeatSequence(completionBeats, {
    autoStart: complete,
    onComplete: onFinished,
  });

  const liveText = complete
    ? (activeBeat?.text ?? "")
    : (phase ? (PHASE_TEXT[phase] ?? "I'm building your business…") : `Thank you${name}. I'm building your business.`);

  const state = complete && done ? "opportunity" : "idle";

  return (
    <>
      <MobileArrivalOverlay text={liveText} state={state} />

      {/* Desktop — deliberately not a full-screen takeover (see the design
          record's platform split). This page has no live Store yet, so
          there's no real TV frame/rail to wake up the way DashboardShell's
          returning-user treatment does — a simple, honest centered panel
          for V1, not a reproduction of chrome that doesn't exist here yet. */}
      <div
        className="mt-6 hidden max-w-md flex-col items-center gap-4 rounded-2xl p-10 text-center md:flex"
        style={{ backgroundColor: GENESIS_ATMOSPHERE.bg, border: `1px solid ${GENESIS_ATMOSPHERE.border}` }}
      >
        <GenesisAvatar state={state} className="h-16 w-16" />
        <p className="text-base font-medium" style={{ color: GENESIS_ATMOSPHERE.text }}>
          {liveText}
        </p>
        {!complete && (
          <p className="text-xs" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
            This usually takes about a minute or two.
          </p>
        )}
      </div>
    </>
  );
}
