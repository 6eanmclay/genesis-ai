"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { GenesisAvatar } from "@/app/dashboard/GenesisAvatar";
import { GENESIS_ATMOSPHERE } from "@/lib/dashboard/genesisAtmosphere";
import { setGenesisWorking, setGenesisComposing } from "@/lib/dashboard/genesisActivity";
import { applyOwnerPrice } from "@/lib/onboarding/pricing";
import {
  submitBrandPositioningAnswer,
  submitCreativeApproachAnswer,
  generateCreativeDirections,
  selectCreativeDirection,
  startFulfillmentConnect,
  buildCreativeProduct,
  discoverHeroProduct,
  getPricingPreview,
  confirmPricing,
} from "../actions";
import type { CreativeDirectionOption, DiscoveryState, DiscoveryStep } from "@/lib/onboarding/types";
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
// Creative Direction (added after the technical MVP froze) — Sean's own
// framing: the owner shouldn't see a random placeholder product; they
// should choose the visual and creative DNA of their business from three
// genuinely different directions Genesis generates, then see their actual
// live storefront before Launch even starts. See the plan this was built
// from for the full reasoning — the short version: the real Store/Product
// gets materialized right after pricing is confirmed (not at Launch's
// "building" beat), so storefront_reveal can embed the real, live
// (unpublished, owner-preview) storefront route instead of a mockup.
//
// Scope, per Sean's explicit instruction: only the "help me find something
// to sell" path (resell) plus the new custom-design fork — the "I already
// have products" branch stays deferred, so the brand-positioning beat goes
// to creative_approach, never asking a product-source question that has
// nowhere real to go yet.

type Beat =
  | "positioning"
  | "approach"
  | "generating_directions"
  | "direction_review"
  | "connecting"
  | "building_product"
  | "considering"
  | "reveal"
  | "pricing"
  | "storefront_reveal"
  | "handoff";

function mapStepToBeat(step: DiscoveryStep): Beat {
  switch (step) {
    case "brand_positioning":
      return "positioning";
    case "creative_approach":
      return "approach";
    case "creative_direction_generating":
      return "generating_directions";
    case "creative_direction_review":
      return "direction_review";
    case "fulfillment_connect":
      return "connecting";
    case "creative_product_building":
      return "building_product";
    case "product_discovery":
      return "considering";
    case "pricing":
      return "pricing";
    case "storefront_reveal":
      return "storefront_reveal";
    case "ready_to_publish":
      return "handoff";
    default:
      return "positioning";
  }
}

const shell = "fixed inset-0 z-[100] flex flex-col items-center justify-center gap-6 px-8 text-center overflow-y-auto py-12";

const primaryButton =
  "rounded-full px-7 py-3 text-sm font-semibold transition-transform hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 disabled:hover:scale-100";
const ghostButton = "rounded-full border px-6 py-2.5 text-sm transition-colors";

// Small, reused inline swatch row — a quick palette hint, not a full color
// picker. Renders the five colors most likely to actually distinguish one
// direction from another at a glance.
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

export function BusinessScreen({ initialState }: { initialState: DiscoveryState }) {
  const router = useRouter();
  const [beat, setBeat] = useState<Beat>(() => mapStepToBeat(initialState.step));
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const [positioningText, setPositioningText] = useState("");

  const [directionOptions, setDirectionOptions] = useState<CreativeDirectionOption[] | null>(
    initialState.creativeDirectionOptions
  );
  const [chosenDirection, setChosenDirection] = useState<CreativeDirectionOption | null>(initialState.creativeDirection);
  const [storeUrl, setStoreUrl] = useState<string | null>(null);
  const [storeName, setStoreName] = useState<string | null>(null);

  const [candidate, setCandidate] = useState<FulfillmentCandidate | null>(initialState.selectedCandidate);
  const [reasoning, setReasoning] = useState<string | null>(initialState.candidateReasoning);

  const [costInCents, setCostInCents] = useState<number | null>(null);
  const [shippingInCents, setShippingInCents] = useState<number | null>(null);
  const [recommendation, setRecommendation] = useState<PriceRecommendation | null>(null);
  const [markupChoice, setMarkupChoice] = useState<"recommended" | "more" | "custom">("recommended");
  const [customPriceInput, setCustomPriceInput] = useState("");

  // "Generating directions" — real async work (a Claude call per direction
  // plus real image generation), auto-advancing once it genuinely resolves.
  // Never a fixed timer.
  useEffect(() => {
    if (beat !== "generating_directions") return;
    let cancelled = false;
    setGenesisWorking(true);
    (async () => {
      setError(null);
      try {
        const { state } = await generateCreativeDirections();
        if (cancelled) return;
        setDirectionOptions(state.creativeDirectionOptions);
        setGenesisWorking(false);
        setBeat("direction_review");
      } catch {
        if (cancelled) return;
        setGenesisWorking(false);
        setError("Genesis couldn't put together any directions just now — try again in a moment.");
        setBeat("approach");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [beat]);

  // "Building product" — real async work (picks a real blank to print on,
  // generates the chosen direction's theme structure). Never a fixed timer.
  useEffect(() => {
    if (beat !== "building_product") return;
    let cancelled = false;
    setGenesisWorking(true);
    (async () => {
      setError(null);
      try {
        await buildCreativeProduct();
        if (cancelled) return;
        setGenesisWorking(false);
        setBeat("pricing");
      } catch {
        if (cancelled) return;
        setGenesisWorking(false);
        setError("Something went wrong — try again.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [beat]);

  // "Considering" — real async work (a real catalog browse + a real Claude
  // call), auto-advancing once it genuinely resolves. Never a fixed timer.
  // Resell path only.
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
        setBeat("approach");
      } catch {
        setGenesisWorking(false);
        setError("Something went wrong — try again.");
      }
    });
  }

  function handleApproachChoice(approach: "custom" | "resell") {
    setError(null);
    startTransition(async () => {
      try {
        const { state } = await submitCreativeApproachAnswer(approach);
        setBeat(mapStepToBeat(state.step));
      } catch {
        setError("Something went wrong — try again.");
      }
    });
  }

  function handleSelectDirection(index: number) {
    setError(null);
    startTransition(async () => {
      try {
        const { state } = await selectCreativeDirection(index);
        setChosenDirection(state.creativeDirection);
        setDirectionOptions(null);
        setBeat(mapStepToBeat(state.step));
      } catch {
        setError("That direction isn't available anymore — try generating again.");
      }
    });
  }

  function handleGenerateAgain() {
    setError(null);
    setDirectionOptions(null);
    setBeat("generating_directions");
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
        const { state, storeUrl: url, storeName: name } = await confirmPricing(finalRetailPriceInCents());
        if (url) setStoreUrl(url);
        if (name) setStoreName(name);
        setBeat(mapStepToBeat(state.step));
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

      {beat === "approach" && (
        <>
          <GenesisAvatar state="idle" className="aspect-square w-[min(42vw,220px)]" />
          <p className="max-w-sm text-xl font-medium" style={{ color: GENESIS_ATMOSPHERE.text }}>
            Are you designing your own products, or picking from what&rsquo;s already out there?
          </p>
          <p className="max-w-sm text-sm" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
            Either way, I&rsquo;ll help you make it real.
          </p>
          <div className="flex w-full max-w-md gap-3">
            <button
              onClick={() => handleApproachChoice("custom")}
              className="flex flex-1 flex-col items-center gap-2 rounded-xl border px-4 py-4 text-sm font-semibold transition-transform hover:-translate-y-0.5"
              style={{ borderColor: GENESIS_ATMOSPHERE.border, color: GENESIS_ATMOSPHERE.text }}
            >
              I&rsquo;m designing something of my own
            </button>
            <button
              onClick={() => handleApproachChoice("resell")}
              className="flex flex-1 flex-col items-center gap-2 rounded-xl border px-4 py-4 text-sm font-semibold transition-transform hover:-translate-y-0.5"
              style={{ borderColor: GENESIS_ATMOSPHERE.border, color: GENESIS_ATMOSPHERE.text }}
            >
              I&rsquo;ll pick from what&rsquo;s already out there
            </button>
          </div>
        </>
      )}

      {beat === "generating_directions" && (
        <>
          <GenesisAvatar state="idle" className="aspect-square w-[min(30vw,120px)]" />
          <p className="max-w-sm text-xl font-medium" style={{ color: GENESIS_ATMOSPHERE.text }}>
            Let me put together a few different directions&hellip;
          </p>
        </>
      )}

      {beat === "direction_review" && directionOptions && directionOptions.length > 0 && (
        <>
          <GenesisAvatar state="idle" className="aspect-square w-[min(24vw,100px)]" />
          <p className="max-w-sm text-xl font-medium" style={{ color: GENESIS_ATMOSPHERE.text }}>
            Which one feels like you?
          </p>
          <p className="max-w-sm text-sm" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
            Pick the one you connect with — I&rsquo;ll build everything else around it.
          </p>
          <div className="flex w-full max-w-3xl flex-wrap justify-center gap-4">
            {directionOptions.map((direction, index) => (
              <button
                key={index}
                onClick={() => handleSelectDirection(index)}
                className="flex w-[min(80vw,220px)] flex-col items-center gap-3 rounded-xl border px-4 py-4 text-center transition-transform hover:-translate-y-0.5"
                style={{ borderColor: GENESIS_ATMOSPHERE.border, backgroundColor: "rgba(244,242,251,0.04)" }}
              >
                <div className="relative">
                  <div
                    className="w-[min(26vw,170px)] aspect-square rounded-[20px] overflow-hidden"
                    style={{ boxShadow: "0 20px 50px rgba(0,0,0,.5), 0 0 0 1px " + GENESIS_ATMOSPHERE.border }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- a freshly generated, provider-hosted image, not a local/optimizable asset */}
                    <img src={direction.productImageUrl} alt={direction.name} className="h-full w-full object-cover" />
                  </div>
                  <div
                    className="absolute -bottom-2 -right-2 h-9 w-9 overflow-hidden rounded-full border-2"
                    style={{ borderColor: GENESIS_ATMOSPHERE.bg, backgroundColor: GENESIS_ATMOSPHERE.bgElevated }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- a freshly generated, provider-hosted image, not a local/optimizable asset */}
                    <img src={direction.logoUrl} alt={`${direction.name} logo`} className="h-full w-full object-cover" />
                  </div>
                </div>
                <p className="text-sm font-semibold" style={{ color: GENESIS_ATMOSPHERE.text }}>
                  {direction.name}
                </p>
                <p className="line-clamp-2 text-xs" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
                  {direction.description}
                </p>
                <PaletteDots colors={direction.colors} />
              </button>
            ))}
          </div>
          <button onClick={handleGenerateAgain} className={ghostButton} style={{ borderColor: GENESIS_ATMOSPHERE.border, color: GENESIS_ATMOSPHERE.textSecondary }}>
            Generate again
          </button>
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

      {beat === "building_product" && (
        <>
          <GenesisAvatar state="idle" className="aspect-square w-[min(30vw,120px)]" />
          <p className="max-w-sm text-xl font-medium" style={{ color: GENESIS_ATMOSPHERE.text }}>
            Bringing it to life&hellip;
          </p>
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
          {chosenDirection && (
            <div className="flex flex-col items-center gap-2">
              <div
                className="w-[min(40vw,150px)] aspect-square rounded-[16px] overflow-hidden"
                style={{ boxShadow: "0 20px 50px rgba(0,0,0,.5), 0 0 0 1px " + GENESIS_ATMOSPHERE.border }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- a freshly generated, provider-hosted image, not a local/optimizable asset */}
                <img src={chosenDirection.productImageUrl} alt={chosenDirection.name} className="h-full w-full object-cover" />
              </div>
              <p className="text-sm font-semibold" style={{ color: GENESIS_ATMOSPHERE.text }}>
                {chosenDirection.name}
              </p>
              <PaletteDots colors={chosenDirection.colors} />
            </div>
          )}
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

      {beat === "storefront_reveal" && storeUrl && (
        <>
          <GenesisAvatar state="idle" className="aspect-square w-[min(20vw,84px)]" />
          <p className="max-w-sm text-xl font-medium" style={{ color: GENESIS_ATMOSPHERE.text }}>
            {storeName ? `${storeName} is real.` : "This is real."}
          </p>
          <p className="max-w-sm text-sm" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
            Your actual storefront — send it to anyone, right now, even before it&rsquo;s live.
          </p>
          <div
            className="w-full max-w-2xl overflow-hidden rounded-2xl border"
            style={{ borderColor: GENESIS_ATMOSPHERE.border, boxShadow: "0 30px 80px rgba(0,0,0,.55)" }}
          >
            <iframe src={storeUrl} title="Your real storefront" className="h-[60vh] w-full bg-white" />
          </div>
          <button
            onClick={() => router.push("/onboarding/launch")}
            className={primaryButton}
            style={{ backgroundColor: GENESIS_ATMOSPHERE.violet, color: GENESIS_ATMOSPHERE.bgElevated }}
          >
            Continue
          </button>
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
