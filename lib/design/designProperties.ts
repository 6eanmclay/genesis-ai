import type { DesignProperty, OwningAction } from "./designChange";
import { ownerOf } from "./designChange";

/**
 * EVERY DESIGN PROPERTY, AND HOW YOU PROVE IT CHANGED.
 *
 * ============ THE RULE THIS ENCODES (Sean, 2026-09-10) =================
 *
 * "Make sure every property has a real visual measurement rather than
 * inheriting a generic verified: true."
 *
 * That sentence is the whole architecture. `update_theme.verify()` returned a
 * perfectly correct `verified` for months while the rendered font never
 * changed, because it checked the stored column - a generic proof that
 * belonged to no property in particular and therefore proved nothing about any
 * of them. See the standing invariant in ARCHITECTURE.md.
 *
 * So a property is not registered here until somebody has written down HOW to
 * see it on the page. The framework generalises; the proof does not.
 *
 * ============ WHAT A MEASUREMENT IS ====================================
 *
 * A selector naming the element that genuinely carries the property, and the
 * thing to read off it. Both halves matter, and the selector is the half that
 * bites: the first version of the font check read `document.querySelector("h1")`
 * and landed on an unthemed heading in the page chrome, reporting the entire
 * pipeline broken when it was measuring the wrong element. Hence the
 * `design-*` hooks on the storefront - an element that carries a property says
 * so, rather than being guessed at.
 */

/** How a property is read off a rendered page. */
export type Measurement =
  /** A computed CSS value on the first element matching the selector. */
  | { kind: "computedStyle"; selector: string; property: string }
  /** A rendered size, for anything whose change is dimensional. */
  | { kind: "boundingBox"; selector: string; axis: "width" | "height" }
  /** The order of sections, for structural changes. */
  | { kind: "domOrder"; selector: string }
  /** The resolved source of an image. */
  | { kind: "attribute"; selector: string; attribute: string };

/**
 * WHERE A PROPERTY STANDS, AND THERE IS NO SIXTH ANSWER.
 *
 * ============ WHY A BOOLEAN WAS NOT ENOUGH (Sean, 2026-09-10) ==========
 *
 * The first version had `proven: boolean`, and within an hour it held three
 * false claims - background, accent and buttonStyle were all marked proven
 * from intent, before anything had been run. A boolean can be asserted by
 * anybody in a hurry, which makes it the same generic `verified: true` this
 * whole system exists to replace, one layer further up.
 *
 * So the states are distinct, and each one CARRIES ITS EVIDENCE:
 *
 *   proven     a before and an after, and they differ. The values are in the
 *              type, so this state cannot be written without them.
 *   failed     the mutation ran, the measurement was valid, and the rendered
 *              value did not move. A real defect, not a gap.
 *   measured   the selector resolves and returns a value, but no before/after
 *              has been run yet.
 *   unproven   there is no valid measurement yet, and `because` says why.
 *   incapable  no executable can mutate this at all.
 *
 * Sean's rule, which is what separates the middle three: "If the feature
 * exists but our measurement can't see it, fix the measurement. If the feature
 * cannot actually execute, mark it incapable. If it executes but produces no
 * rendered change, that's a failed verification. Those are three different
 * states."
 */
export type PropertyStatus =
  | { state: "proven"; before: string; after: string }
  | { state: "failed"; before: string; after: string; because: string }
  | { state: "measured"; value: string }
  | { state: "unproven"; because: string }
  | { state: "incapable"; because: string };

export interface RegisteredProperty {
  /** The owner-facing name, used in J4's own report. */
  label: string;
  property: DesignProperty;
  /** Which executable can actually change it. Derived, never asserted. */
  owner: OwningAction;
  /** How to see it on the page. Required — there is no default. */
  measure: Measurement;
  /**
   * Where this property stands, with the evidence attached.
   *
   * verify-design-properties recomputes this from a real browser and fails if
   * the registry claims more than the page shows. It is a record of what was
   * observed, not a promise about what should happen.
   */
  status: PropertyStatus;
}

export const DESIGN_PROPERTIES: Record<string, RegisteredProperty> = {
  // ---- 1. TYPOGRAPHY -----------------------------------------------------
  headingFont: {
    label: "the heading font",
    property: { group: "typography", field: "headingFont" },
    owner: "update_theme",
    measure: { kind: "computedStyle", selector: "[class*='--font-heading']", property: "fontFamily" },
    status: { state: "proven", before: "Oswald, sans-serif", after: `"Playfair Display", sans-serif` },
  },
  bodyFont: {
    label: "the body font",
    property: { group: "typography", field: "bodyFont" },
    owner: "update_theme",
    measure: { kind: "computedStyle", selector: "[class*='--font-body']", property: "fontFamily" },
    status: { state: "proven", before: "Lora, sans-serif", after: `"Space Mono", sans-serif` },
  },

  // ---- 2. COLOURS --------------------------------------------------------
  // Read off the elements that consume the brand variables, not off :root -
  // a variable can be set and used by nothing, which is exactly how the font
  // was correct and invisible for months.
  background: {
    label: "the background colour",
    property: { group: "colors", field: "background" },
    owner: "update_theme",
    // `body` READ THE WRONG ELEMENT, and read it convincingly: it returned a
    // real colour, rgb(250,250,248), that simply never moved - so the first
    // measurement diagnosed the FEATURE as broken when the instrument was
    // pointed one element too high. The storefront paints its ground on the
    // root div, which says so with `design-ground`.
    measure: { kind: "computedStyle", selector: ".design-ground", property: "backgroundColor" },
    status: { state: "proven", before: "rgb(250, 250, 250)", after: "rgb(26, 13, 46)" },
  },
  accent: {
    label: "the accent colour",
    property: { group: "colors", field: "accent" },
    owner: "update_theme",
    // NO ELEMENT for two runs, and the selector was right the whole time: the
    // buy button only renders once a store can take payments, so a fixture
    // with no Stripe or PayPal row has nothing to measure. The page state was
    // wrong, not the measurement — see the fixture note in the suite.
    measure: { kind: "computedStyle", selector: ".design-button", property: "backgroundColor" },
    status: { state: "proven", before: "rgb(24, 24, 27)", after: "rgb(255, 107, 53)" },
  },
  text: {
    label: "the text colour",
    property: { group: "colors", field: "text" },
    owner: "update_theme",
    // Same element, same reason as `background`: `design-ground` is where the
    // storefront sets both, and body inherits nothing from it.
    measure: { kind: "computedStyle", selector: ".design-ground", property: "color" },
    status: { state: "proven", before: "rgb(24, 24, 27)", after: "rgb(11, 61, 46)" },
  },

  // ---- 3. BUTTONS / COMPONENTS -------------------------------------------
  buttonStyle: {
    label: "the button shape",
    property: { group: "presentation", field: "buttonStyle" },
    owner: "refine_storefront",
    measure: { kind: "computedStyle", selector: ".design-button", property: "borderRadius" },
    // Same missing button as `accent`, and then a second, separate fault: the
    // suite refined buttonStyle to `pill`, which is already the default. The
    // page rendered the same radius twice and was right to. The huge `before`
    // is what `rounded-full` computes to, not a bug.
    status: { state: "proven", before: "3.35544e+07px", after: "6px" },
  },

  // ---- 4. SPACING --------------------------------------------------------
  spacing: {
    label: "the spacing",
    property: { group: "presentation", field: "spacing" },
    owner: "refine_storefront",
    measure: { kind: "computedStyle", selector: "#products", property: "paddingTop" },
    // Watched to move on a spacious refinement.
    status: { state: "proven", before: "56px", after: "96px" },
  },

  // ---- 5. BORDER RADIUS (cards) -----------------------------------------
  cardStyle: {
    label: "the card corners",
    property: { group: "presentation", field: "cardStyle" },
    owner: "refine_storefront",
    measure: { kind: "computedStyle", selector: ".design-card", property: "borderRadius" },
    // Watched to move on a sharp refinement.
    status: { state: "proven", before: "16px", after: "6px" },
  },

  // ---- 6. SECTION / LAYOUT STRUCTURE ------------------------------------
  sectionLayout: {
    label: "the section layout",
    property: { group: "composition", field: "sectionLayout" },
    owner: "refine_storefront",
    // `#products` read "none" on both sides because it is the product grid's
    // OUTER section, which was never going to carry a template - a container
    // chosen for having the right-sounding id. The property actually reshapes
    // the inner wrapper of a text section: `centered` gives it no grid at all,
    // `split` gives it two columns. Addressed as a direct child so the
    // selector resolves in every variant, not only the one being switched to.
    measure: { kind: "computedStyle", selector: "#about > div", property: "gridTemplateColumns" },
    // Resolved columns rather than a class name, because the rendered grid is
    // what the owner sees. The pixel values are the 1fr/2fr split the suite's
    // fixed 1280px viewport resolves to.
    status: { state: "proven", before: "none", after: "221.328px 442.672px" },
  },

  // ---- 7. IMAGES ---------------------------------------------------------
  imageTreatment: {
    label: "how product images are treated",
    property: { group: "composition", field: "imageTreatment" },
    owner: "refine_storefront",
    // `.design-card img` was the wrong element AND the wrong property.
    // imageTreatment does not touch product-card images and it never sets
    // object-fit; it swaps the FRAME around the hero image - `contained` is a
    // 1px border, `fullBleed` no border at all, `framed` a 2px accent border
    // with padding. So the border width is the thing that moves.
    measure: { kind: "computedStyle", selector: ".design-hero-image", property: "borderTopWidth" },
    status: { state: "proven", before: "1px", after: "0px" },
  },

  // ---- 8. HERO COMPOSITION ----------------------------------------------
  // Dimensional rather than a computed value: the hero's change is that it is
  // a different SHAPE, and no single CSS property says that.
  heroLayout: {
    label: "the hero layout",
    property: { group: "composition", field: "heroLayout" },
    owner: "refine_storefront",
    // 285px BOTH SIDES, and the element was right - the comparison was not.
    // The old fixture sat on `centered` and switched to `fullBleed`, and those
    // two heroes are the same headline, subheadline and CTA at the same
    // padding; fullBleed's difference is an atmospheric gradient layer behind
    // them. Identical height was the correct answer to the wrong question.
    // From a `split` hero - two columns with an aspect-square image slot - the
    // height is exactly what changes, which is also what an owner sees.
    measure: { kind: "boundingBox", selector: "header", axis: "height" },
    // 637px of two-column hero with an image slot, down to a 285px text-only
    // band. The one property here whose proof is a size rather than a value.
    status: { state: "proven", before: "637", after: "285" },
  },
};

/** Every property whose owning action disagrees with the registry. */
export function ownershipDrift(): string[] {
  return Object.entries(DESIGN_PROPERTIES)
    .filter(([, r]) => ownerOf(r.property) !== r.owner)
    .map(([key]) => key);
}

/** Properties in each state, so a report never has to count them by hand. */
export function propertiesInState(state: PropertyStatus["state"]): string[] {
  return Object.entries(DESIGN_PROPERTIES).filter(([, r]) => r.status.state === state).map(([k]) => k);
}

/** A proven status must carry two values that actually differ. */
export function statusIsSelfConsistent(status: PropertyStatus): boolean {
  if (status.state === "proven") return status.before !== status.after && status.after.length > 0;
  if (status.state === "failed") return status.before === status.after;
  return true;
}

/**
 * The two readings a measurement can return that are not values at all. They
 * live here rather than in the verifier so the reader and the judge cannot
 * drift apart on what "nothing" looks like.
 */
export const NO_ELEMENT = "NO ELEMENT";
export const NO_VALUE = "(empty)";

/**
 * WHAT THE PAGE SAID — DERIVED FROM THE READINGS AND NOTHING ELSE.
 *
 * Deliberately takes no registry argument. A judge that can see the claim it is
 * judging is the `verified: true` bug moved one layer up: it will agree.
 *
 * The three outcomes are Sean's three, kept apart on purpose:
 *
 *   unproven  the instrument saw nothing. A statement about the MEASUREMENT —
 *             nothing is yet known about the feature either way.
 *   failed    the instrument worked, the mutation ran, the rendered value did
 *             not move. A statement about the PRODUCT. A real defect.
 *   proven    two valid readings that differ.
 *
 * "If the feature exists but our measurement can't see it, fix the measurement.
 * If it executes but produces no rendered change, that's a failed verification."
 */
export function observeStatus(before: string, after: string, changed: boolean): PropertyStatus {
  if (before === NO_ELEMENT || after === NO_ELEMENT)
    return { state: "unproven", because: "the selector matched no element on the rendered page" };
  if (before === NO_VALUE || after === NO_VALUE)
    return { state: "unproven", because: "the element exists but the measured property read empty" };
  if (changed) return { state: "proven", before, after };
  return { state: "failed", before, after, because: "the mutation ran and the rendered value did not move" };
}

/**
 * EVERY WAY A REGISTRY ENTRY CAN DISAGREE WITH THE BROWSER. Empty means it did
 * not disagree; each string is one owner-readable reason.
 *
 * Strict, and in BOTH directions. A registry allowed to state anything weaker
 * than the truth can absorb a real defect by calling it a gap — "the
 * measurement never worked" reads as housekeeping where "the rendered value did
 * not move" reads as the bug it is. Sean: "Never silently convert failures into
 * unproven." Equality enforces that only because it also refuses the reverse.
 */
export function claimViolations(claim: PropertyStatus, observed: PropertyStatus): string[] {
  // The one state a browser cannot be asked to reproduce: if nothing can mutate
  // the property there is no before/after to compare. All the page can do is
  // contradict it, by moving.
  if (claim.state === "incapable") {
    return observed.state === "proven"
      ? [`claims incapable, but the rendered value changed to ${observed.after}`]
      : [];
  }
  if (claim.state !== observed.state) {
    return [`claims ${claim.state}, but the browser saw ${observed.state}`];
  }
  // A claim of proof has to keep proving itself. The recorded values ARE the
  // evidence; if the page now renders something else the claim is stale, even
  // though its state is still nominally the right word.
  if (claim.state === "proven" && observed.state === "proven") {
    const violations: string[] = [];
    if (claim.before !== observed.before)
      violations.push(`recorded a before of ${claim.before}, page rendered ${observed.before}`);
    if (claim.after !== observed.after)
      violations.push(`recorded an after of ${claim.after}, page rendered ${observed.after}`);
    return violations;
  }
  return [];
}
