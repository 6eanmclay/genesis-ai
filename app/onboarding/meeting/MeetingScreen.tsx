"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { GenesisAvatar } from "@/app/dashboard/GenesisAvatar";
import { GENESIS_ATMOSPHERE } from "@/lib/dashboard/genesisAtmosphere";
import { setGenesisComposing } from "@/lib/dashboard/genesisActivity";
import { submitMeetingVision } from "./actions";

// The First Meeting with J4 — MEETING_WITH_J4.md, frozen v1. Same visual
// treatment as LaunchScreen.tsx (the Partnership ceremony this meeting
// directly continues): idle avatar throughout, real async work, no
// fabricated progress. M4 builds Reflect + Listen — the "listen" beat's
// submit is real, not a placeholder, but what happens after it will change
// under M5-M7 as Ask/Recommend/Execute get added before completion.
type Beat = "reflect" | "listen" | "completing";

const shell =
  "fixed inset-0 z-[100] flex flex-col items-center justify-center gap-6 px-8 text-center overflow-y-auto py-12";

const primaryButton =
  "rounded-full px-7 py-3 text-sm font-semibold transition-transform hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 disabled:hover:scale-100";

export function MeetingScreen({ reflection }: { reflection: string }) {
  const router = useRouter();
  const [beat, setBeat] = useState<Beat>("reflect");
  const [vision, setVision] = useState("");
  const [, startTransition] = useTransition();

  return (
    <div className={shell} style={{ backgroundColor: GENESIS_ATMOSPHERE.bg }}>
      <GenesisAvatar state="idle" className="aspect-square w-[min(42vw,220px)]" />

      {beat === "reflect" && (
        <>
          <p className="max-w-md text-lg font-medium" style={{ color: GENESIS_ATMOSPHERE.text }}>
            {reflection}
          </p>
          <button
            onClick={() => setBeat("listen")}
            className={primaryButton}
            style={{ backgroundColor: GENESIS_ATMOSPHERE.violet, color: GENESIS_ATMOSPHERE.bgElevated }}
          >
            Continue
          </button>
        </>
      )}

      {(beat === "listen" || beat === "completing") && (
        <>
          <p className="max-w-md text-lg font-medium" style={{ color: GENESIS_ATMOSPHERE.text }}>
            What do you want this to become?
          </p>
          <p className="max-w-sm text-sm" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
            Tell me the vision — as much or as little as you want.
          </p>
          <textarea
            value={vision}
            onChange={(e) => setVision(e.target.value)}
            onFocus={() => setGenesisComposing(true)}
            onBlur={() => setGenesisComposing(false)}
            disabled={beat === "completing"}
            rows={4}
            placeholder="Where do you see this a year from now…"
            className="w-full max-w-md rounded-2xl border px-5 py-4 text-sm"
            style={{
              backgroundColor: "rgba(244,242,251,0.04)",
              borderColor: GENESIS_ATMOSPHERE.border,
              color: GENESIS_ATMOSPHERE.text,
            }}
          />
          <button
            onClick={() => {
              setBeat("completing");
              startTransition(async () => {
                await submitMeetingVision(vision);
                router.push("/dashboard");
              });
            }}
            disabled={beat === "completing"}
            className={primaryButton}
            style={{ backgroundColor: GENESIS_ATMOSPHERE.violet, color: GENESIS_ATMOSPHERE.bgElevated }}
          >
            {beat === "completing" ? "One moment..." : "Continue"}
          </button>
        </>
      )}
    </div>
  );
}
