import type { CSSProperties } from "react";

export type ThemeColors = {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  surface: string;
  text: string;
  textSecondary: string;
};

export type Presentation = {
  cardStyle: "sharp" | "rounded" | "soft";
  buttonStyle: "sharp" | "pill" | "soft";
  shadowStyle: "none" | "subtle" | "bold";
  spacing: "compact" | "comfortable" | "spacious";
};

// Structural/compositional choices — distinct from Presentation above
// (uniform low-level styling: radius, shadow, spacing applied identically
// everywhere). This is what actually varies the page's SHAPE per brand:
// hero structure, heading scale, section internal layout, backgrounds,
// image framing, and CTA composition. Still a fixed enum mapped to
// hand-built, tested variants below — never free-form CSS from the AI.
export type Composition = {
  heroLayout: "centered" | "split" | "fullBleed" | "minimal";
  typeScale: "compact" | "standard" | "display";
  sectionLayout: "centered" | "split" | "boxed";
  backgroundTreatment: "flat" | "tintBands" | "bordered";
  imageTreatment: "contained" | "fullBleed" | "framed";
  ctaEmphasis: "button" | "banner" | "minimal";
};

export type Theme = {
  colors: ThemeColors;
  typography: { headingFont: string; bodyFont: string };
  layout: "grid" | "list" | "featured";
  presentation?: Presentation;
  composition?: Composition;
};

const DEFAULT_PRESENTATION: Presentation = {
  cardStyle: "rounded",
  buttonStyle: "pill",
  shadowStyle: "subtle",
  spacing: "comfortable",
};

// Chosen to reproduce today's actual hardcoded rendering exactly — a
// store/draft with no composition yet (or predating this field) falls back
// to these and renders pixel-identical to before this system existed.
const DEFAULT_COMPOSITION: Composition = {
  heroLayout: "centered",
  typeScale: "standard",
  sectionLayout: "centered",
  backgroundTreatment: "tintBands",
  imageTreatment: "contained",
  ctaEmphasis: "button",
};

export const DEFAULT_THEME: Theme = {
  colors: {
    primary: "#18181b",
    secondary: "#3f3f46",
    accent: "#18181b",
    background: "#fafafa",
    surface: "#ffffff",
    text: "#18181b",
    textSecondary: "#71717a",
  },
  typography: { headingFont: "", bodyFont: "" },
  layout: "grid",
  presentation: DEFAULT_PRESENTATION,
  composition: DEFAULT_COMPOSITION,
};

// Builds a Google Fonts stylesheet URL for the given font family names.
// Names come from free-text AI generation, so this degrades gracefully if a
// font doesn't exist on Google Fonts (the browser just falls back).
export function googleFontsUrl(fonts: string[]): string | null {
  const families = [...new Set(fonts.map((f) => f.trim()).filter(Boolean))];
  if (families.length === 0) return null;

  const query = families
    .map((f) => `family=${encodeURIComponent(f).replace(/%20/g, "+")}:wght@400;500;600;700`)
    .join("&");
  return `https://fonts.googleapis.com/css2?${query}&display=swap`;
}

export function themeCssVars(theme: Theme): CSSProperties {
  return {
    "--brand-primary": theme.colors.primary,
    "--brand-secondary": theme.colors.secondary,
    "--brand-accent": theme.colors.accent,
    "--brand-background": theme.colors.background,
    "--brand-surface": theme.colors.surface,
    "--brand-text": theme.colors.text,
    "--brand-text-secondary": theme.colors.textSecondary,
    "--font-heading": theme.typography.headingFont
      ? `"${theme.typography.headingFont}", sans-serif`
      : "inherit",
    "--font-body": theme.typography.bodyFont
      ? `"${theme.typography.bodyFont}", sans-serif`
      : "inherit",
  } as CSSProperties;
}

// Structured, fixed Tailwind class lookups — deliberately never free-form
// CSS from the AI, just a choice among safe, known-good presets. Old data
// generated before `presentation` existed falls back to the same defaults
// the storefront always used, so nothing breaks for stores that predate it.
const CARD_RADIUS: Record<Presentation["cardStyle"], string> = {
  sharp: "rounded-md",
  rounded: "rounded-2xl",
  soft: "rounded-[2rem]",
};

const BUTTON_RADIUS: Record<Presentation["buttonStyle"], string> = {
  sharp: "rounded-md",
  pill: "rounded-full",
  soft: "rounded-2xl",
};

const SHADOW: Record<Presentation["shadowStyle"], string> = {
  none: "",
  subtle: "shadow-sm hover:shadow-md",
  bold: "shadow-lg hover:shadow-2xl",
};

const SECTION_PADDING: Record<Presentation["spacing"], string> = {
  compact: "py-8",
  comfortable: "py-14",
  spacious: "py-24",
};

const CONTENT_GAP: Record<Presentation["spacing"], string> = {
  compact: "gap-4",
  comfortable: "gap-6",
  spacious: "gap-10",
};

function presentationOf(theme: Theme): Presentation {
  return theme.presentation ?? DEFAULT_PRESENTATION;
}

export function cardRadiusClass(theme: Theme): string {
  return CARD_RADIUS[presentationOf(theme).cardStyle];
}

export function buttonRadiusClass(theme: Theme): string {
  return BUTTON_RADIUS[presentationOf(theme).buttonStyle];
}

export function shadowClass(theme: Theme): string {
  return SHADOW[presentationOf(theme).shadowStyle];
}

export function sectionPaddingClass(theme: Theme): string {
  return SECTION_PADDING[presentationOf(theme).spacing];
}

export function contentGapClass(theme: Theme): string {
  return CONTENT_GAP[presentationOf(theme).spacing];
}

function compositionOf(theme: Theme): Composition {
  return theme.composition ?? DEFAULT_COMPOSITION;
}

export function heroLayoutOf(theme: Theme): Composition["heroLayout"] {
  return compositionOf(theme).heroLayout;
}

/**
 * Does this hero layout render an image at all? (2026-08-22)
 *
 * ONE ANSWER, in one place, because two of them is the defect this exists to
 * close. Of the four hero layouts, only `split` has an image slot — the other
 * three render a headline, a subheadline and a call to action, and nothing
 * else. The default is `centered`.
 *
 * So a hero image applied to a default-themed store is written to the record,
 * round-trips perfectly, and appears nowhere. updateHero's verify() confirmed
 * exactly that round-trip and reported success, which is the failure Sean named
 * directly: "the verification step should confirm the image actually exists in
 * the resulting storefront... J4 should not report the change as completed if
 * it only changed the text/layout while failing to apply the referenced image."
 *
 * The storefront and that verify() now read this same function, so the check
 * cannot say yes while the renderer says no.
 */
export function heroLayoutRendersImage(layout: Composition["heroLayout"]): boolean {
  return layout === "split";
}

export function ctaEmphasisOf(theme: Theme): Composition["ctaEmphasis"] {
  return compositionOf(theme).ctaEmphasis;
}

// `sectionLayout` is a single global choice for this beta scope — not yet
// per-section. Callers should go through this resolver (not
// `compositionOf(theme).sectionLayout` directly) so that adding a later,
// optional per-section override map only requires changing the body here,
// with zero changes at any call site.
export function sectionLayoutFor(theme: Theme, _section: string): Composition["sectionLayout"] {
  return compositionOf(theme).sectionLayout;
}

const HEADING_SCALE: Record<Composition["typeScale"], { h1: string; h2: string }> = {
  compact: { h1: "text-3xl font-bold tracking-tight sm:text-4xl", h2: "text-xl font-semibold" },
  standard: { h1: "text-4xl font-bold tracking-tight sm:text-5xl", h2: "text-2xl font-semibold" },
  display: { h1: "text-5xl font-extrabold tracking-tight sm:text-7xl", h2: "text-3xl font-bold" },
};

export function headingScaleClass(theme: Theme, level: "h1" | "h2"): string {
  return HEADING_SCALE[compositionOf(theme).typeScale][level];
}

// Each variant fully controls its own radius usage rather than appending
// fragments to a shared radius class, so variants never fight each other
// over conflicting Tailwind rounding utilities.
const IMAGE_FRAME: Record<Composition["imageTreatment"], (radiusClass: string) => string> = {
  contained: (radius) => `${radius} border border-[var(--brand-text)]/[.08]`,
  fullBleed: () => "",
  framed: (radius) => `${radius} border-2 border-[var(--brand-accent)]/40 bg-[var(--brand-surface)] p-1.5`,
};

export function imageFrameClass(theme: Theme, radiusClass: string): string {
  return IMAGE_FRAME[compositionOf(theme).imageTreatment](radiusClass);
}

// `wantsBand` preserves each section's existing identity (today:
// whyChooseUs/customSection/newsletter are banded, about/brandStory are
// flush) so the "tintBands" default reproduces current output exactly.
export function sectionBandClass(theme: Theme, wantsBand: boolean): string {
  const treatment = compositionOf(theme).backgroundTreatment;
  if (treatment === "flat") return "";
  if (treatment === "bordered") return "border-t-2 border-[var(--brand-accent)]/30";
  return wantsBand ? "border-t border-[var(--brand-text)]/[.08] bg-[var(--brand-surface)]" : "";
}
