"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { GenesisAvatar } from "@/app/dashboard/GenesisAvatar";
import { GENESIS_ATMOSPHERE } from "@/lib/dashboard/genesisAtmosphere";
import { setGenesisWorking, setGenesisComposing } from "@/lib/dashboard/genesisActivity";
import { submitBusinessModelAnswer } from "./actions";

// The Genesis Experience — the reference screen (GENESIS_EXPERIENCE.md,
// "The reference screen"), locked as the standard every later screen in
// this experience is measured against. Contains exactly what that section
// specifies and nothing more — before adding anything here, the burden of
// proof is "the experience is measurably better because of this," not
// "this would be nice to have."
//
// state="idle", not "curiosity" — verified against lib/dashboard/
// genesisState.ts's real definition before building this: curiosity means
// "an active explanation-kind CognitiveOutput exists" (Genesis found
// something worth understanding), which is never true before any business
// or data exists yet. idle is the honest state here, same default
// GenesisArrivalOverlay.tsx already uses for arrival.
//
// "Thinking" (while the real classification call is in flight) and the
// one-shot "response" exhale (right as it resolves) are both genuine,
// already-built Genesis activity states (lib/dashboard/genesisActivity.ts)
// driven by a real request, not a manufactured delay — see GENESIS_
// EXPERIENCE.md principle 2, never fake progress.
export function IdeaScreen() {
  const router = useRouter();
  const [idea, setIdea] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const submittedRef = useRef(false);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = idea.trim();
    if (!trimmed || submittedRef.current) return;
    submittedRef.current = true;
    setError(null);
    setGenesisComposing(false);
    setGenesisWorking(true);

    startTransition(async () => {
      try {
        const { state } = await submitBusinessModelAnswer(trimmed);
        setGenesisWorking(false);
        // The real "response" pulse plays first (GenesisAvatar's own
        // RESPONSE_DURATION_MS), then the real next destination — the
        // Business act if this classified as ecommerce, otherwise the
        // honest fallback (GENESIS_EXPERIENCE.md section 4's scope
        // boundary: every other business model isn't designed yet).
        const destination = state.step === "not_ecommerce" ? "/dashboard" : "/onboarding/business";
        setTimeout(() => router.push(destination), 1400);
      } catch {
        setGenesisWorking(false);
        submittedRef.current = false;
        setError("Something went wrong — try again.");
      }
    });
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-8 px-8 text-center"
      style={{ backgroundColor: GENESIS_ATMOSPHERE.bg }}
    >
      <GenesisAvatar state="idle" className="aspect-square w-[min(58vw,340px)]" wakeOnMount />

      <p
        className="genesis-onboarding-rise max-w-sm text-xl font-medium"
        style={{ color: GENESIS_ATMOSPHERE.text, animationDelay: "1400ms" }}
      >
        {"What's the business you've been meaning to start?"}
      </p>
      <p
        className="genesis-onboarding-rise -mt-4 text-sm"
        style={{ color: GENESIS_ATMOSPHERE.textSecondary, animationDelay: "1900ms" }}
      >
        {"Tell me the idea — I'll take it from here."}
      </p>

      <form onSubmit={handleSubmit} className="genesis-onboarding-rise w-full max-w-md" style={{ animationDelay: "2300ms" }}>
        <div
          className="genesis-onboarding-input-wrap flex items-center rounded-full border pl-6 pr-1.5 py-1.5 transition-all"
          style={{
            backgroundColor: "rgba(244,242,251,0.04)",
            borderColor: GENESIS_ATMOSPHERE.border,
          }}
        >
          <input
            type="text"
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
            onFocus={() => setGenesisComposing(true)}
            onBlur={() => setGenesisComposing(false)}
            placeholder="A candle shop for people who hate how candles usually smell…"
            autoComplete="off"
            disabled={isPending}
            className="flex-1 bg-transparent py-3.5 px-2 text-base outline-none placeholder:text-white/30"
            style={{ color: GENESIS_ATMOSPHERE.text }}
          />
          <button
            type="submit"
            disabled={isPending || !idea.trim()}
            aria-label="Send"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-transform hover:scale-105 active:scale-95 disabled:opacity-40"
            style={{ backgroundColor: GENESIS_ATMOSPHERE.violet, color: GENESIS_ATMOSPHERE.bgElevated }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M5 12h13M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
        {error && (
          <p className="mt-3 text-sm" style={{ color: "#f87171" }}>
            {error}
          </p>
        )}
      </form>
    </div>
  );
}
