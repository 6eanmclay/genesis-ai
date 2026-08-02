"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { GenesisAvatar } from "@/app/dashboard/GenesisAvatar";
import { GENESIS_ATMOSPHERE } from "@/lib/dashboard/genesisAtmosphere";
import { setGenesisWorking, setGenesisComposing } from "@/lib/dashboard/genesisActivity";
import { applyOwnerPrice } from "@/lib/onboarding/pricing";
import {
  submitBrandPositioningAnswer,
  startFulfillmentConnect,
  discoverHeroProduct,
  getPricingPreview,
  confirmPricing,
} from "../actions";
import type { DiscoveryStep } from "@/lib/onboarding/types";
import type { FulfillmentCandidate } from "@/lib/fulfillment/types";
import type { PriceRecommendation } from "@/lib/onboarding/pricing";

// The Genesis Experience — Business act. Real implementation of the
// confirmed mockup (see GENESIS_EXPERIENCE.md's "The reference screen" and
// the Business act storyboard) — every beat here calls the real backend
// built for it, no fabricated data. Same standard as IdeaScreen.tsx: idle
// state throughout (curiosity/opportunity both require a persisted
// CognitiveOutput/GenesisObservation, neither of which this flow creates),
// real "thinking"/"response" activity tempo carrying the aliveness during
// real async work.
//
// Scope, per Sean's explicit instruction: only the "help me find something
// to sell" path — the "I already have products" branch stays deferred, so
// the brand-positioning beat goes straight to fulfillment_connect, never
// asking a product-source question that has nowhere real to go yet.

type Beat = "positioning" | "connecting" | "considering" | "reveal" | "pricing" | "handoff";

function mapStepToBeat(step: DiscoveryStep): Beat {
  switch (step) {
    case "brand_positioning":
      return "positioning";
    case "fulfillment_connect":
      return "connecting";
    case "product_discovery":
      return "considering";
    case "pricing":
      return "pricing";
    case "ready_to_publish":
      return "handoff";
    default:
      return "positioning";
  }
}

const shell = "fixed inset-0 z-[100] flex flex-col items-center justify-center gap-6 px-8 text-center overflow-y-auto py-12";

export function BusinessScreen({ initialStep }: { initialStep: DiscoveryStep }) {
  const router = useRouter();
  const [beat, setBeat] = useState<Beat>(() => mapStepToBeat(initialStep));
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const [positioningText, setPositioningText] = useState("");

  const [candidate, setCandidate] = useState<FulfillmentCandidate | null>(null);
  const [reasoning, setReasoning] = useState<string | null>(null);

  const [costInCents, setCostInCents] = useState<number | null>(null);
  const [shippingInCents, setShippingInCents] = useState<number | null>(null);
  const [recommendation, setRecommendation] = useState<PriceRecommendation | null>(null);
  const [markupChoice, setMarkupChoice] = useState<"recommended" | "more" | "custom">("recommended");
  const [customPriceInput, setCustomPriceInput] = useState("");

  // "Considering" — real async work (a real catalog browse + a real Claude
  // call), auto-advancing once it genuinely resolves. Never a fixed timer.
  useEffect(() => {
    if (beat !== "considering") return;
    let cancelled = false;
    setGenesisWorking(true);
    (async () => {
      setError(null);
      try {
        const { state } = await discoverHeroProduct();
        if (cancelled) return;
        setCandidate(state.selectedCandidate);
        setReasoning(state.candidateReasoning);
        setGenesisWorking(false);
        setBeat("reveal");
      } catch {
        if (cancelled) return;
        setGenesisWorking(false);
        setError("Genesis couldn't find a product just now — try again in a moment.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [beat]);

  // Pricing beat mount — the real cost/price/profit preview.
  useEffect(() => {
    if (beat !== "pricing") return;
    let cancelled = false;
    (async () => {
      try {
        const preview = await getPricingPreview();
        if (cancelled) return;
        setCostInCents(preview.costInCents);
        setShippingInCents(preview.shippingInCents);
        setRecommendation(preview.recommendation);
      } catch {
        if (cancelled) return;
        setError("Couldn't load real pricing — try again.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [beat]);

  function handlePositioningSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = positioningText.trim();
    if (!trimmed) return;
    setError(null);
    setGenesisComposing(false);
    setGenesisWorking(true);
    startTransition(async () => {
      try {
        await submitBrandPositioningAnswer(trimmed);
        setGenesisWorking(false);
        setBeat("connecting");
      } catch {
        setGenesisWorking(false);
        setError("Something went wrong — try again.");
      }
    });
  }

  function handleConnect() {
    setError(null);
    startTransition(async () => {
      try {
        const { authorizeUrl } = await startFulfillmentConnect();
        window.location.href = authorizeUrl;
      } catch {
        setError("Couldn't start the connection — try again.");
      }
    });
  }

  function finalRetailPriceInCents(): number | undefined {
    if (!recommendation) return undefined;
    if (markupChoice === "recommended") return undefined; // let the server use its own recommendation
    if (markupChoice === "custom") {
      const dollars = parseFloat(customPriceInput);
      return isNaN(dollars) ? undefined : Math.round(dollars * 100);
    }
    // "more" — a higher margin computed locally with the same real formula
    // (lib/onboarding/pricing.ts), previewed instantly without a round trip.
    if (costInCents === null || shippingInCents === null) return undefined;
    const higherMargin = Math.min(recommendation.marginPct + 0.1, 0.6);
    const totalCost = costInCents + shippingInCents;
    return Math.round(totalCost / (1 - higherMargin));
  }

  function displayedPrice(): PriceRecommendation | null {
    if (!recommendation || costInCents === null || shippingInCents === null) return recommendation;
    if (markupChoice === "recommended") return recommendation;
    const cents = finalRetailPriceInCents();
    if (cents === undefined) return recommendation;
    return applyOwnerPrice(costInCents, shippingInCents, cents);
  }

  function handleContinueFromPricing() {
    setError(null);
    startTransition(async () => {
      try {
        await confirmPricing(finalRetailPriceInCents());
        setBeat("handoff");
      } catch {
        setError("Something went wrong — try again.");
      }
    });
  }

  const shown = displayedPrice();

  return (
    <div className={shell} style={{ backgroundColor: GENESIS_ATMOSPHERE.bg }}>
      {beat === "positioning" && (
        <>
          <GenesisAvatar state="idle" className="aspect-square w-[min(42vw,220px)]" />
          <p className="max-w-sm text-xl font-medium" style={{ color: GENESIS_ATMOSPHERE.text }}>
            {"Got it. Who's this for, and what feeling should it have?"}
          </p>
          <p className="text-sm" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
            {"Tell me in your own words — I'll take it from here."}
          </p>
          <form onSubmit={handlePositioningSubmit} className="w-full max-w-md">
            <div
              className="genesis-onboarding-input-wrap flex items-center rounded-full border pl-6 pr-1.5 py-1.5"
              style={{ backgroundColor: "rgba(244,242,251,0.04)", borderColor: GENESIS_ATMOSPHERE.border }}
            >
              <input
                type="text"
                value={positioningText}
                onChange={(e) => setPositioningText(e.target.value)}
                onFocus={() => setGenesisComposing(true)}
                onBlur={() => setGenesisComposing(false)}
                placeholder="Clean and minimalist — nothing loud."
                autoComplete="off"
                className="flex-1 bg-transparent py-3.5 px-2 text-base outline-none placeholder:text-white/30"
                style={{ color: GENESIS_ATMOSPHERE.text }}
              />
              <button
                type="submit"
                disabled={!positioningText.trim()}
                aria-label="Send"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-transform hover:scale-105 active:scale-95 disabled:opacity-40"
                style={{ backgroundColor: GENESIS_ATMOSPHERE.violet, color: GENESIS_ATMOSPHERE.bgElevated }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M5 12h13M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
          </form>
        </>
      )}

      {beat === "connecting" && (
        <>
          <GenesisAvatar state="idle" className="aspect-square w-[min(42vw,220px)]" />
          <p className="max-w-sm text-xl font-medium" style={{ color: GENESIS_ATMOSPHERE.text }}>
            One more thing — setting up how this gets made and shipped.
          </p>
          <p className="max-w-sm text-sm" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
            Takes about thirty seconds. You&rsquo;ll come right back here.
          </p>
          <button
            onClick={handleConnect}
            className="rounded-full px-7 py-3 text-sm font-semibold transition-transform hover:scale-[1.02] active:scale-[0.98]"
            style={{ backgroundColor: GENESIS_ATMOSPHERE.violet, color: GENESIS_ATMOSPHERE.bgElevated }}
          >
            Continue
          </button>
        </>
      )}

      {beat === "considering" && (
        <>
          <GenesisAvatar state="idle" className="aspect-square w-[min(42vw,220px)]" />
          <p className="max-w-sm text-xl font-medium" style={{ color: GENESIS_ATMOSPHERE.text }}>
            Let me find something that actually fits&hellip;
          </p>
        </>
      )}

      {beat === "reveal" && candidate && (
        <>
          <GenesisAvatar state="idle" className="aspect-square w-[min(24vw,110px)]" />
          <div
            className="w-[min(64vw,300px)] aspect-square rounded-[20px] overflow-hidden"
            style={{ boxShadow: "0 30px 80px rgba(0,0,0,.55), 0 0 0 1px " + GENESIS_ATMOSPHERE.border }}
          >
            {candidate.imageUrl && (
              // eslint-disable-next-line @next/next/no-img-element -- an external, provider-hosted catalog image, not a local/optimizable asset
              <img src={candidate.imageUrl} alt={candidate.name} className="h-full w-full object-cover" />
            )}
          </div>
          <p className="max-w-sm text-base font-semibold" style={{ color: GENESIS_ATMOSPHERE.text }}>
            {candidate.name}
          </p>
          {reasoning && (
            <p className="max-w-sm text-lg font-medium" style={{ color: GENESIS_ATMOSPHERE.text }}>
              {reasoning}
            </p>
          )}
          <button
            onClick={() => setBeat("pricing")}
            className="mt-2 rounded-full px-7 py-3 text-sm font-semibold transition-transform hover:scale-[1.02] active:scale-[0.98]"
            style={{ backgroundColor: GENESIS_ATMOSPHERE.violet, color: GENESIS_ATMOSPHERE.bgElevated }}
          >
            This is the one
          </button>
        </>
      )}

      {beat === "pricing" && (
        <>
          <GenesisAvatar state="idle" className="aspect-square w-[min(24vw,100px)]" />
          <p className="text-lg font-medium" style={{ color: GENESIS_ATMOSPHERE.text }}>
            Here&rsquo;s the real math.
          </p>
          {shown && costInCents !== null && shippingInCents !== null ? (
            <>
              <div className="w-full max-w-md">
                <div className="flex items-baseline justify-between border-b py-3" style={{ borderColor: GENESIS_ATMOSPHERE.border }}>
                  <span className="text-sm" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
                    What it costs to make
                  </span>
                  <span className="text-base font-medium" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
                    ${((costInCents + shippingInCents) / 100).toFixed(2)}
                  </span>
                </div>
                <div className="flex items-baseline justify-between border-b py-3" style={{ borderColor: GENESIS_ATMOSPHERE.border }}>
                  <span className="text-sm" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
                    Genesis recommends selling at
                  </span>
                  <span className="text-lg font-semibold" style={{ color: GENESIS_ATMOSPHERE.text }}>
                    ${(shown.retailPriceInCents / 100).toFixed(2)}
                  </span>
                </div>
                <div className="flex items-baseline justify-between py-3">
                  <span className="text-sm" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
                    You&rsquo;d keep, per sale
                  </span>
                  <span className="text-lg font-semibold" style={{ color: "#4ade80" }}>
                    ${(shown.profitInCents / 100).toFixed(2)}
                  </span>
                </div>
              </div>

              <div className="flex flex-wrap justify-center gap-2 pt-2">
                {(["recommended", "more", "custom"] as const).map((choice) => (
                  <button
                    key={choice}
                    onClick={() => setMarkupChoice(choice)}
                    className="rounded-full border px-4 py-2 text-sm transition-all"
                    style={{
                      borderColor: markupChoice === choice ? GENESIS_ATMOSPHERE.violet : GENESIS_ATMOSPHERE.border,
                      backgroundColor: markupChoice === choice ? GENESIS_ATMOSPHERE.violet : "rgba(244,242,251,0.04)",
                      color: markupChoice === choice ? GENESIS_ATMOSPHERE.bgElevated : GENESIS_ATMOSPHERE.textSecondary,
                      fontWeight: markupChoice === choice ? 600 : 400,
                    }}
                  >
                    {choice === "recommended" ? "Use this price" : choice === "more" ? "A bit more margin" : "Set my own"}
                  </button>
                ))}
              </div>
              {markupChoice === "custom" && (
                <input
                  type="text"
                  inputMode="decimal"
                  value={customPriceInput}
                  onChange={(e) => setCustomPriceInput(e.target.value)}
                  placeholder={(shown.retailPriceInCents / 100).toFixed(2)}
                  className="w-32 rounded-full border px-4 py-2 text-center text-sm outline-none"
                  style={{ borderColor: GENESIS_ATMOSPHERE.border, backgroundColor: "rgba(244,242,251,0.04)", color: GENESIS_ATMOSPHERE.text }}
                />
              )}

              <button
                onClick={handleContinueFromPricing}
                className="mt-4 rounded-full px-7 py-3 text-sm font-semibold transition-transform hover:scale-[1.02] active:scale-[0.98]"
                style={{ backgroundColor: GENESIS_ATMOSPHERE.violet, color: GENESIS_ATMOSPHERE.bgElevated }}
              >
                Continue
              </button>
            </>
          ) : (
            <p className="text-sm" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
              Getting the real numbers&hellip;
            </p>
          )}
        </>
      )}

      {beat === "handoff" && (
        <>
          <GenesisAvatar state="idle" className="aspect-square w-[min(42vw,220px)]" />
          <p className="max-w-sm text-xl font-medium" style={{ color: GENESIS_ATMOSPHERE.text }}>
            This is a real business now.
          </p>
          <button
            onClick={() => router.push("/onboarding/launch")}
            className="rounded-full px-7 py-3 text-sm font-semibold transition-transform hover:scale-[1.02] active:scale-[0.98]"
            style={{ backgroundColor: GENESIS_ATMOSPHERE.violet, color: GENESIS_ATMOSPHERE.bgElevated }}
          >
            Continue
          </button>
        </>
      )}

      {error && (
        <p className="max-w-sm text-sm" style={{ color: "#f87171" }}>
          {error}
        </p>
      )}
    </div>
  );
}
