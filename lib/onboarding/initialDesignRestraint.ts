import { DEFAULT_THEME, type Presentation, type Composition } from "@/lib/theme";

// Conservative initial generation (2026-08-12) — audit pass #1.
//
// Sean's framing: "Don't make the first storefront boring or ugly. Make it
// competent, clean, professional, and appropriate to the business — but
// deliberately conservative. Don't spend every available design decision
// immediately." The owner should look at their first site and think "yeah,
// that's a legitimate website," not "J4 redesigned the entire internet."
//
// The reason this is code and not only prompt text is the same reason the
// storefront suggestion governor is code: a model asked for restraint is
// restrained on average. A budget that is actually enforced is restrained
// every time. This is the mechanism that leaves J4 something to earn later.
//
// Nothing here changes the Theme schema, the renderer, or any existing
// store. It only narrows which of the already-valid variants a BRAND NEW
// storefront is allowed to open with.

// The calm option for each of the ten structural choices. Deliberately
// DEFAULT_THEME's own values rather than a second opinion invented here —
// lib/theme.ts documents those as reproducing the storefront's original
// hardcoded rendering exactly, which makes them the one baseline in this
// codebase already proven to look correct on every real store.
const BASELINE_PRESENTATION: Presentation = DEFAULT_THEME.presentation!;
const BASELINE_COMPOSITION: Composition = DEFAULT_THEME.composition!;

// How many of the ten choices a first storefront may move off baseline.
//
// Four, not ten: enough that the store reads as built for this specific
// business rather than from a template, and not so many that day one already
// spends every decision J4 could later earn. Ten would be the current
// behaviour — every dial turned at once, at maximum confidence, before a
// single order has ever been placed.
export const INITIAL_DESIGN_BUDGET = 4;

// Which departures survive when the model overspends, most-kept first.
//
// Ordered by identity carried per unit of loudness. Hero layout and type
// scale are how a storefront announces what kind of business it is, and they
// do it structurally rather than by shouting. Shadow style and CTA emphasis
// are the opposite — they are the dials that make a page feel like it is
// trying too hard, and they are the cheapest to give back. A first storefront
// that differs from baseline only in its hero and its typography still looks
// deliberate; one that differs only in bold shadows looks like a theme demo.
const DEPARTURE_PRIORITY = [
  "heroLayout",
  "typeScale",
  "cardStyle",
  "spacing",
  "imageTreatment",
  "sectionLayout",
  "buttonStyle",
  "backgroundTreatment",
  "ctaEmphasis",
  "shadowStyle",
] as const;

type DepartureKey = (typeof DEPARTURE_PRIORITY)[number];

export interface InitialDesignRestraintResult {
  presentation: Presentation;
  composition: Composition;
  /** Choices allowed to stay off baseline, in priority order. */
  kept: DepartureKey[];
  /** Choices pulled back to baseline because the budget was already spent. */
  reverted: DepartureKey[];
}

function isPresentationKey(key: DepartureKey): key is keyof Presentation & DepartureKey {
  return key in BASELINE_PRESENTATION;
}

// Applies the budget. Every value the model chose is already schema-valid, so
// this never invents a variant — it only decides which of its choices to keep
// and pulls the rest back to a baseline that is known to render correctly.
export function applyInitialDesignRestraint(proposed: {
  presentation: Presentation;
  composition: Composition;
}): InitialDesignRestraintResult {
  const presentation: Presentation = { ...proposed.presentation };
  const composition: Composition = { ...proposed.composition };

  const departures = DEPARTURE_PRIORITY.filter((key) =>
    isPresentationKey(key)
      ? presentation[key] !== BASELINE_PRESENTATION[key]
      : composition[key as keyof Composition] !== BASELINE_COMPOSITION[key as keyof Composition]
  );

  const kept = departures.slice(0, INITIAL_DESIGN_BUDGET);
  const reverted = departures.slice(INITIAL_DESIGN_BUDGET);

  for (const key of reverted) {
    if (isPresentationKey(key)) {
      // @ts-expect-error — key is a verified key of Presentation; the union
      // narrowing can't carry the value type across both records at once.
      presentation[key] = BASELINE_PRESENTATION[key];
    } else {
      const k = key as keyof Composition;
      // @ts-expect-error — same narrowing limitation, Composition side.
      composition[k] = BASELINE_COMPOSITION[k];
    }
  }

  return { presentation, composition, kept: [...kept], reverted: [...reverted] };
}
