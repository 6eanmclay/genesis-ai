// Storefront Canvas, step 3 of 6 (2026-08-12) — the closed vocabulary
// refine_storefront is allowed to move.
//
// Every dimension and every value here already exists in lib/theme.ts. This
// file adds no new design capability whatsoever; it only makes the existing
// enum vocabulary addressable one dimension at a time, instead of reachable
// only by rewriting the entire theme through update_theme.
//
// The rule this preserves: the model never emits CSS. It picks from variants
// that are hand-built and tested, which is why a generated storefront cannot
// render broken. Widening this file is the only way to widen what J4 can
// change, and doing so should be a deliberate decision rather than a
// side effect.

export type DimensionGroup = "presentation" | "composition";

export interface RefinableDimension {
  group: DimensionGroup;
  values: readonly string[];
  /** Owner-facing name, for the approval card and J4's own prose. */
  label: string;
}

// Mirrors Presentation and Composition in lib/theme.ts exactly. Kept as a
// literal rather than derived from the types because TypeScript types are
// erased at runtime and this needs to validate real model output.
export const REFINABLE_DIMENSIONS = {
  // Presentation — uniform low-level styling applied identically everywhere.
  cardStyle: { group: "presentation", label: "Card style", values: ["sharp", "rounded", "soft"] },
  buttonStyle: { group: "presentation", label: "Button style", values: ["sharp", "pill", "soft"] },
  shadowStyle: { group: "presentation", label: "Shadow style", values: ["none", "subtle", "bold"] },
  spacing: { group: "presentation", label: "Spacing", values: ["compact", "comfortable", "spacious"] },
  // Composition — what actually varies the page's shape per brand.
  heroLayout: { group: "composition", label: "Hero layout", values: ["centered", "split", "fullBleed", "minimal"] },
  typeScale: { group: "composition", label: "Type scale", values: ["compact", "standard", "display"] },
  sectionLayout: { group: "composition", label: "Section layout", values: ["centered", "split", "boxed"] },
  backgroundTreatment: { group: "composition", label: "Background treatment", values: ["flat", "tintBands", "bordered"] },
  imageTreatment: { group: "composition", label: "Image treatment", values: ["contained", "fullBleed", "framed"] },
  ctaEmphasis: { group: "composition", label: "Call to action emphasis", values: ["button", "banner", "minimal"] },
} as const satisfies Record<string, RefinableDimension>;

export type RefinableDimensionKey = keyof typeof REFINABLE_DIMENSIONS;

export const REFINABLE_DIMENSION_KEYS = Object.keys(REFINABLE_DIMENSIONS) as RefinableDimensionKey[];

// The cap Sean set: four internal mutations may add up to one meaningful
// improvement, and no more. Four is the implementation detail of a single
// idea, not four separate requests, and the allowance must not be used to
// disguise a broader redesign. If an improvement genuinely needs more, the
// proposal should be simplified or split into a second improvement.
export const MAX_MUTATIONS_PER_IMPROVEMENT = 4;

/** hasOwnProperty rather than `in`, so Object.prototype members are rejected. */
export function isRefinableDimension(value: unknown): value is RefinableDimensionKey {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(REFINABLE_DIMENSIONS, value);
}

/** Whether a value is one this dimension genuinely accepts. */
export function isValidDimensionValue(dimension: RefinableDimensionKey, value: unknown): boolean {
  return typeof value === "string" && (REFINABLE_DIMENSIONS[dimension].values as readonly string[]).includes(value);
}

export function dimensionGroup(dimension: RefinableDimensionKey): DimensionGroup {
  return REFINABLE_DIMENSIONS[dimension].group;
}

export function describeDimension(dimension: RefinableDimensionKey): string {
  return REFINABLE_DIMENSIONS[dimension].label;
}
