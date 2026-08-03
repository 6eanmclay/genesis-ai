"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { GenesisAvatar } from "@/app/dashboard/GenesisAvatar";
import { GENESIS_ATMOSPHERE } from "@/lib/dashboard/genesisAtmosphere";
import { setGenesisWorking, setGenesisComposing } from "@/lib/dashboard/genesisActivity";
import { submitExperienceMessage } from "@/app/onboarding/actions";
import type { CreativeDirectionOption, ExperienceConcept, ExperienceState } from "@/lib/onboarding/types";

// Experience-First Onboarding, Milestone 2 — the new root landing
// experience (EXPERIENCE_FIRST_ONBOARDING.md), replacing the old marketing
// page. Deliberately built to the same standard as IdeaScreen.tsx (the
// Genesis Experience's own "reference screen"): idle state throughout (no
// CognitiveOutput exists yet to justify curiosity/opportunity), real
// "thinking"/"response" activity tempo carrying the aliveness, no chrome
// beyond what GENESIS_EXPERIENCE.md's reference screen itself contains.
//
// Conversational, not wizard-like, per Sean's explicit brief: there is no
// step indicator and no persisted visible transcript — only the current
// spoken line changes, exactly like a real back-and-forth. The one-question
// cap (MAX_VISITOR_TURNS_BEFORE_FORCED_GENERATION in lib/onboarding/
// experienceFlow.ts) is enforced server-side, inside the same swappable
// decideExperienceNextStep boundary a future J4 reasoning engine replaces —
// nothing about this component depends on how that decision gets made.

const shell = "fixed inset-0 z-[100] flex flex-col items-center justify-center gap-6 px-8 text-center overflow-y-auto py-12";

function PaletteDots({ colors }: { colors: CreativeDirectionOption["colors"] }) {
  const swatches = [colors.primary, colors.accent, colors.secondary, colors.background, colors.surface];
  return (
    <div className="flex items-center justify-center gap-1.5">
      {swatches.map((c, i) => (
        <span key={i} className="h-3 w-3 rounded-full border border-white/10" style={{ backgroundColor: c }} />
      ))}
    </div>
  );
}

type ViewState =
  | { phase: "prompting"; question: string; isFirst: boolean }
  | { phase: "revealed"; concept: ExperienceConcept };

function initialViewState(state: ExperienceState): ViewState {
  if (state.status === "generated" && state.concept) {
    return { phase: "revealed", concept: state.concept };
  }
  const lastGenesisTurn = [...state.transcript].reverse().find((entry) => entry.role === "genesis");
  return {
    phase: "prompting",
    question: lastGenesisTurn?.text ?? "What's the business you've been meaning to start?",
    isFirst: state.transcript.length === 0,
  };
}

export function ExperienceScreen({ initialState }: { initialState: ExperienceState }) {
  const [view, setView] = useState<ViewState>(() => initialViewState(initialState));
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const submittedRef = useRef(false);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || submittedRef.current) return;
    submittedRef.current = true;
    setError(null);
    setGenesisComposing(false);
    setGenesisWorking(true);

    startTransition(async () => {
      try {
        const result = await submitExperienceMessage(trimmed);
        setGenesisWorking(false);
        setInput("");
        // The real "response" pulse plays first (GenesisAvatar's own
        // RESPONSE_DURATION_MS), then the next real beat — same pacing
        // IdeaScreen.tsx already uses, never a manufactured delay beyond
        // that one genuine animation.
        setTimeout(() => {
          if (result.status === "generated") {
            setView({ phase: "revealed", concept: result.concept });
          } else {
            setView({ phase: "prompting", question: result.question, isFirst: false });
          }
          submittedRef.current = false;
        }, 1400);
      } catch {
        setGenesisWorking(false);
        submittedRef.current = false;
        setError("Something went wrong — try again.");
      }
    });
  }

  if (view.phase === "revealed") {
    return <RevealPanel concept={view.concept} />;
  }

  return (
    <div className={shell} style={{ backgroundColor: GENESIS_ATMOSPHERE.bg }}>
      <Link
        href="/login"
        className="absolute right-6 top-6 text-xs font-medium"
        style={{ color: GENESIS_ATMOSPHERE.textSecondary }}
      >
        Log in
      </Link>

      <GenesisAvatar state="idle" className="aspect-square w-[min(58vw,340px)]" wakeOnMount />

      <p
        key={view.question}
        className="genesis-onboarding-rise max-w-sm text-xl font-medium"
        style={{ color: GENESIS_ATMOSPHERE.text, animationDelay: view.isFirst ? "1400ms" : "0ms" }}
      >
        {view.question}
      </p>
      {view.isFirst && (
        <p
          className="genesis-onboarding-rise -mt-4 text-sm"
          style={{ color: GENESIS_ATMOSPHERE.textSecondary, animationDelay: "1900ms" }}
        >
          {"Tell me the idea — I'll take it from here."}
        </p>
      )}

      <form
        onSubmit={handleSubmit}
        className="genesis-onboarding-rise w-full max-w-md"
        style={{ animationDelay: view.isFirst ? "2300ms" : "200ms" }}
      >
        <div
          className="genesis-onboarding-input-wrap flex items-center rounded-full border pl-6 pr-1.5 py-1.5 transition-all"
          style={{ backgroundColor: "rgba(244,242,251,0.04)", borderColor: GENESIS_ATMOSPHERE.border }}
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onFocus={() => setGenesisComposing(true)}
            onBlur={() => setGenesisComposing(false)}
            placeholder={
              view.isFirst ? "A candle shop for people who hate how candles usually smell…" : "Type your answer…"
            }
            autoComplete="off"
            disabled={isPending}
            className="flex-1 bg-transparent py-3.5 px-2 text-base outline-none placeholder:text-white/30"
            style={{ color: GENESIS_ATMOSPHERE.text }}
          />
          <button
            type="submit"
            disabled={isPending || !input.trim()}
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

// The reveal moment — EXPERIENCE_FIRST_ONBOARDING.md step 4: "the owner
// sees the real result." Deliberately not yet the full storefront-styled
// preview (that's Milestone 3, built next against the generated theme via
// lib/theme.ts) — this is Genesis's own reveal of what it just built, same
// visual vocabulary BusinessScreen.tsx's "reveal"/"pricing" beats already
// use (product-image card, logo badge, palette dots), staying in Genesis's
// own atmosphere rather than the business's brand colors.
//
// The description below IS the "Genesis understands the idea, out loud"
// moment (GENESIS_EXPERIENCE.md) — decideExperienceNextStep is prompted to
// write it as a reflected insight, not a generic tagline, so this same
// field does double duty as both brand copy and that felt moment.
function RevealPanel({ concept }: { concept: ExperienceConcept }) {
  const direction = concept.creativeDirection;
  const price = (concept.pricing.retailPriceInCents / 100).toFixed(2);
  const profit = (concept.pricing.profitInCents / 100).toFixed(2);

  return (
    <div className={shell} style={{ backgroundColor: GENESIS_ATMOSPHERE.bg }}>
      <GenesisAvatar state="idle" className="aspect-square w-[min(24vw,110px)]" />

      <p className="genesis-onboarding-rise max-w-md text-lg font-medium" style={{ color: GENESIS_ATMOSPHERE.text }}>
        {direction.description}
      </p>

      <div className="genesis-onboarding-rise flex flex-col items-center gap-3" style={{ animationDelay: "500ms" }}>
        <h1 className="text-3xl font-bold tracking-tight" style={{ color: GENESIS_ATMOSPHERE.text }}>
          {direction.name}
        </h1>

        <div className="relative">
          <div
            className="w-[min(64vw,260px)] aspect-square rounded-[20px] overflow-hidden"
            style={{ boxShadow: "0 30px 80px rgba(0,0,0,.55), 0 0 0 1px " + GENESIS_ATMOSPHERE.border }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- a freshly generated, provider-hosted image, not a local/optimizable asset */}
            <img src={direction.productImageUrl} alt={concept.productName} className="h-full w-full object-cover" />
          </div>
          <div
            className="absolute -bottom-2 -right-2 h-12 w-12 overflow-hidden rounded-full border-2"
            style={{ borderColor: GENESIS_ATMOSPHERE.bg, backgroundColor: GENESIS_ATMOSPHERE.bgElevated }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- a freshly generated, provider-hosted image, not a local/optimizable asset */}
            <img src={direction.logoUrl} alt={`${direction.name} logo`} className="h-full w-full object-cover" />
          </div>
        </div>

        <PaletteDots colors={direction.colors} />

        <p className="text-base font-semibold" style={{ color: GENESIS_ATMOSPHERE.text }}>
          {concept.productName}
        </p>

        <p className="text-2xl font-semibold" style={{ color: GENESIS_ATMOSPHERE.violet }}>
          ${price}
        </p>
        <p className="max-w-xs text-sm" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
          {`Estimated for now — you'd keep about $${profit} of every sale.`}
        </p>
      </div>
    </div>
  );
}
