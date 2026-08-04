"use client";

import Link from "next/link";
import {
  themeCssVars,
  cardRadiusClass,
  buttonRadiusClass,
  shadowClass,
  headingScaleClass,
  imageFrameClass,
  googleFontsUrl,
} from "@/lib/theme";
import type { Theme } from "@/lib/theme";
import type { ExperienceConcept } from "@/lib/onboarding/types";

// Experience-First Onboarding, Milestone 3 — the real storefront preview.
// Deliberately NOT a mockup and NOT a variant of RevealPanel's Genesis-
// atmosphere card (app/ExperienceScreen.tsx): this renders through the same
// theme system the real, live /store/[slug] route uses (lib/theme.ts's
// themeCssVars/cardRadiusClass/etc.), in the business's own generated
// colors and fonts, not Genesis's violet. See the approved implementation
// plan's decision #1 for why this is a separate, purpose-built component
// rather than literally sharing JSX with that 811-line, revenue-critical
// file — the visual grammar (hero, framed product image, CSS vars) is
// copied from its real renderHero()/product-card patterns on purpose, so
// nothing about the RESULT looks improvised.
//
// No presentation/composition is generated yet for this one-product
// preview (ExperienceConcept doesn't carry either) — every theme.ts
// utility below already falls back to DEFAULT_PRESENTATION/
// DEFAULT_COMPOSITION when absent, so this still renders through the real
// system, just without per-brand layout variation yet. A real gap, not a
// silent one: the real Store's own generation step produces those later,
// at claim (Milestone 4), same as it already does for the activation flow.
//
// No buy button yet — GENESIS_EXPERIENCE.md's Preview section ("checkout
// present, not hidden, but intentionally not yet capable of taking a
// payment") describes the activation flow's real, published-URL preview;
// this pre-account moment has no real URL or checkout route at all yet.
// What IS real and present: "Let's make this real" — a genuine link to
// /signup, which (per Sean's explicit product principle, 2026-08-03) is
// the one and only ask this screen makes. Clicking it doesn't just start a
// generic signup — claimExperienceDraft() (called from app/signup/page.tsx
// right after the real account is created) claims this exact concept, so
// the promise the button makes is one the code actually keeps.
export function StorefrontPreview({ concept }: { concept: ExperienceConcept }) {
  const direction = concept.creativeDirection;
  const theme: Theme = { colors: direction.colors, typography: direction.typography, layout: "featured" };
  const fontsUrl = googleFontsUrl([direction.typography.headingFont, direction.typography.bodyFont]);
  const cardRadius = cardRadiusClass(theme);
  const imageFrame = imageFrameClass(theme, cardRadius);
  const shadow = shadowClass(theme);
  const buttonRadius = buttonRadiusClass(theme);
  const h1Class = headingScaleClass(theme, "h1");
  const price = (concept.pricing.retailPriceInCents / 100).toFixed(2);

  return (
    <div
      style={themeCssVars(theme)}
      className="min-h-screen bg-[var(--brand-background)] font-[var(--font-body)] text-[var(--brand-text)]"
    >
      {fontsUrl && <link rel="stylesheet" href={fontsUrl} />}

      <nav className="flex items-center justify-center gap-2 border-b border-[var(--brand-text)]/[.08] px-8 py-4">
        <div className="h-7 w-7 shrink-0 overflow-hidden rounded-full">
          {/* eslint-disable-next-line @next/next/no-img-element -- a freshly generated, provider-hosted image, not a local/optimizable asset */}
          <img src={direction.logoUrl} alt="" className="h-full w-full object-cover" />
        </div>
        <span className="font-[var(--font-heading)] text-sm font-semibold">{direction.name}</span>
      </nav>

      <header className="border-b border-[var(--brand-text)]/[.08] px-8 py-16 text-center">
        <h1 className={`font-[var(--font-heading)] ${h1Class}`}>{direction.name}</h1>
        <p className="mx-auto mt-4 max-w-xl text-lg text-[var(--brand-text-secondary)]">{direction.description}</p>
      </header>

      <section className="mx-auto max-w-md px-8 py-14 text-center">
        <div className={`aspect-square w-full overflow-hidden ${imageFrame} ${shadow}`}>
          {/* eslint-disable-next-line @next/next/no-img-element -- a freshly generated, provider-hosted image, not a local/optimizable asset */}
          <img src={direction.productImageUrl} alt={concept.productName} className="h-full w-full object-cover" />
        </div>
        <p className="mt-5 text-base font-semibold">{concept.productName}</p>
        <p className="mt-1 text-2xl font-semibold" style={{ color: direction.colors.accent }}>
          ${price}
        </p>
        <p className="mt-1 text-xs text-[var(--brand-text-secondary)]">Estimated for now</p>
      </section>

      <section className="border-t border-[var(--brand-text)]/[.08] px-8 py-14 text-center">
        <p className="mx-auto max-w-sm text-base text-[var(--brand-text-secondary)]">
          {"This is already real — your name, your product, your storefront. If you like what you see:"}
        </p>
        <Link
          href="/signup"
          className={`mt-5 inline-block ${buttonRadius} px-8 py-3.5 text-base font-semibold text-white transition-opacity hover:opacity-90`}
          style={{ backgroundColor: direction.colors.accent }}
        >
          Let&rsquo;s make this real
        </Link>
      </section>

      <footer className="border-t border-[var(--brand-text)]/[.08] px-8 py-6 text-center text-xs text-[var(--brand-text-secondary)]">
        Built with Genesis, just now.
      </footer>
    </div>
  );
}
