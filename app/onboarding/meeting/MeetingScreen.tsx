"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { GenesisAvatar } from "@/app/dashboard/GenesisAvatar";
import { GENESIS_ATMOSPHERE } from "@/lib/dashboard/genesisAtmosphere";
import { completeFirstMeeting } from "./actions";

// The First Meeting with J4 — MEETING_WITH_J4.md, frozen v1. Same visual
// treatment as LaunchScreen.tsx (the Partnership ceremony this meeting
// directly continues): idle avatar throughout, real async work, no
// fabricated progress. M3 builds Reflect only — the Continue control below
// is real, not a placeholder, but what it does will change under M4-M7 as
// Listen/Ask/Recommend/Execute get added between Reflect and completion.
type Beat = "reflect" | "completing";

const shell =
  "fixed inset-0 z-[100] flex flex-col items-center justify-center gap-6 px-8 text-center overflow-y-auto py-12";

const primaryButton =
  "rounded-full px-7 py-3 text-sm font-semibold transition-transform hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 disabled:hover:scale-100";

export function MeetingScreen({ reflection }: { reflection: string }) {
  const router = useRouter();
  const [beat, setBeat] = useState<Beat>("reflect");
  const [, startTransition] = useTransition();

  return (
    <div className={shell} style={{ backgroundColor: GENESIS_ATMOSPHERE.bg }}>
      <GenesisAvatar state="idle" className="aspect-square w-[min(42vw,220px)]" />
      <p className="max-w-md text-lg font-medium" style={{ color: GENESIS_ATMOSPHERE.text }}>
        {reflection}
      </p>
      <button
        onClick={() => {
          setBeat("completing");
          startTransition(async () => {
            await completeFirstMeeting();
            router.push("/dashboard");
          });
        }}
        disabled={beat === "completing"}
        className={primaryButton}
        style={{ backgroundColor: GENESIS_ATMOSPHERE.violet, color: GENESIS_ATMOSPHERE.bgElevated }}
      >
        {beat === "completing" ? "One moment..." : "Continue"}
      </button>
    </div>
  );
}
