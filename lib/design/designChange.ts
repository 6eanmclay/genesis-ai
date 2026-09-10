import type { Theme } from "@/lib/theme";

/**
 * WHAT THE OWNER ASKED TO CHANGE, AND WHETHER IT CHANGED.
 *
 * ============ THE DEFECT THIS EXISTS TO END (2026-09-09) ===============
 *
 * Sean, repeatedly: "I have told J4 to change the font on my website. J4 says
 * it changed the font, but what I actually see is either the same font or an
 * extremely similar substitute, while something else such as the color
 * changes."
 *
 * Traced in production, and it is worse than a substitution. On 5 September he
 * said the site looked grey; J4 replied that it had warmed the palette and used
 * "a more characterful headline font", and the execution log for that
 * conversation reads:
 *
 *     store.refine_storefront  FAILED  "warm cream base with copper-toned
 *                                       section bands" is not a real option
 *                                       for Background treatment.
 *     store.refine_storefront  FAILED  "solid copper fill" is not a real
 *                                       option for Button style.
 *
 * Eight failures in a row, and J4 reported success. Two separate faults:
 *
 *   1. ROUTING. refine_storefront's vocabulary has no typography in it at all
 *      - its own comment says so: "Colours and typography are deliberately
 *      untouched... a palette or font change remains update_theme's job". So a
 *      font request sent there cannot succeed, and the nearest thing it can
 *      touch is a colour or a type SCALE. That is the "cosmetic substitution"
 *      Sean named: "J4 should never substitute a nearby change because it is
 *      easier to implement."
 *
 *   2. CLAIMED SUCCESS. The reply was written independently of the outcome, so
 *      "Done" survived eight failed executions.
 *
 * ============ REQUESTED PROPERTY -> IMPLEMENTATION -> RESULT ===========
 *
 * So a design change is a RECORD rather than a message: which property, what
 * it was, what it is now, and whether those differ. `changed` is computed, not
 * asserted - nothing can construct a DesignChange that claims a change it did
 * not make, because the field is derived from before and after.
 *
 * That is the same shape as the rest of J4's loop: understands -> explains ->
 * owner chooses -> executes -> VERIFIES -> reports. This is the verify step
 * for design, and the reporting step is downstream of it rather than beside it.
 */

/** A design property, named precisely enough to be changed and read back. */
export type DesignProperty =
  | { group: "typography"; field: "headingFont" | "bodyFont" }
  | { group: "colors"; field: keyof Theme["colors"] }
  | { group: "presentation"; field: string }
  | { group: "composition"; field: string };

/** Which action owns a property. A request routed elsewhere cannot succeed. */
export type OwningAction = "update_theme" | "refine_storefront";

export function ownerOf(property: DesignProperty): OwningAction {
  // refineStorefront.ts states the boundary in its own words; this encodes it
  // so a request can be routed by it rather than by the model's guess.
  return property.group === "typography" || property.group === "colors"
    ? "update_theme"
    : "refine_storefront";
}

export interface DesignChange {
  property: DesignProperty;
  /** The value before, exactly as stored. Empty string when unset. */
  before: string;
  /** The value after. */
  after: string;
  /**
   * Whether this is a real change.
   *
   * DERIVED, never supplied. The whole defect was a claim of change that
   * outlived the change, so the claim is not a field anyone can set.
   */
  readonly changed: boolean;
}

export function designChange(property: DesignProperty, before: string, after: string): DesignChange {
  const b = (before ?? "").trim();
  const a = (after ?? "").trim();
  return { property, before: b, after: a, changed: b !== a };
}

/**
 * Whether two font families are different enough for an owner to SEE it.
 *
 * Sean: "It cannot choose a nearly identical font and claim that the website
 * has meaningfully changed if the owner asked for a different font."
 *
 * Case and whitespace are not a difference. Neither is the same family with a
 * different weight suffix, nor the generic fallback the browser would land on
 * anyway - "Helvetica" to "Helvetica Neue" is a substitution an owner would
 * reasonably call "you didn't change it".
 */
export function isPerceptibleFontChange(before: string, after: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/["']/g, "")
      .replace(/\b(light|regular|medium|semibold|bold|black|italic|neue|new|pro|std|mt|ms)\b/g, "")
      .replace(/[^a-z]/g, "");
  const b = norm(before);
  const a = norm(after);
  if (a.length === 0) return false;
  if (b === a) return false;
  // One containing the other is a variant, not a new typeface.
  if (b.length > 0 && (b.includes(a) || a.includes(b))) return false;
  return true;
}

/** Reads a property's current value out of a theme. */
export function readProperty(theme: Theme, property: DesignProperty): string {
  switch (property.group) {
    case "typography":
      return theme.typography?.[property.field] ?? "";
    case "colors":
      return theme.colors?.[property.field] ?? "";
    case "presentation":
      return (theme.presentation as Record<string, string> | undefined)?.[property.field] ?? "";
    case "composition":
      return (theme.composition as Record<string, string> | undefined)?.[property.field] ?? "";
  }
}

/**
 * What J4 is allowed to say about a design change.
 *
 * Built from the record rather than written beside it, so "I changed the font"
 * cannot be said about a change that did not happen. When nothing moved it
 * says so plainly - which is the sentence that was missing on 5 September.
 */
export function reportChange(change: DesignChange): string {
  const what = describeProperty(change.property);
  if (!change.changed) {
    return `I did not change ${what} — it is still ${change.before || "unset"}.`;
  }
  if (change.property.group === "typography" && !isPerceptibleFontChange(change.before, change.after)) {
    return `I changed ${what} from ${change.before || "unset"} to ${change.after}, but they are close enough that you may not see a difference. Say the word and I will pick something with more contrast.`;
  }
  return `I changed ${what} from ${change.before || "unset"} to ${change.after}.`;
}

export function describeProperty(property: DesignProperty): string {
  if (property.group === "typography") {
    return property.field === "headingFont" ? "the heading font" : "the body font";
  }
  if (property.group === "colors") return `the ${String(property.field)} colour`;
  // presentation/composition fields are camelCase keys the owner never sees.
  return String(property.field).replace(/([A-Z])/g, " $1").toLowerCase().trim();
}

/**
 * WHETHER J4 MAY SAY IT DID IT.
 *
 * ============ THE SECOND FAULT (2026-09-09) ============================
 *
 * On 5 September eight refine_storefront executions FAILED and J4 told Sean
 * the storefront had been warmed up and given "a more characterful headline
 * font". The reply was written beside the outcome rather than from it, so
 * "Done" outlived eight failures.
 *
 * Sean: "J4 must not report success until the rendered website verifies the
 * change... No fake completion. No cosmetic substitution. No close enough."
 *
 * So completion is DERIVED from three facts, and there is no argument for
 * "succeeded" that any caller can pass in:
 *
 *   executed   did the mutation run at all
 *   changed    did the property actually differ afterwards
 *   rendered   did the page verifiably show it
 *
 * `rendered` is deliberately allowed to be null - "we could not check" is not
 * the same as "it did not work", which is the distinction
 * lib/execution/verification.ts already draws for the rest of the system, and
 * it earns the same three states here.
 */
export type DesignOutcome =
  | { state: "verified"; report: string }
  | { state: "changed_but_unverified"; report: string }
  | { state: "not_changed"; report: string }
  | { state: "failed"; report: string };

export function designOutcome(params: {
  executed: boolean;
  change: DesignChange | null;
  /** True/false from a real render check, or null when none could run. */
  rendered: boolean | null;
  /** What went wrong, when the mutation itself failed. */
  failure?: string | null;
}): DesignOutcome {
  if (!params.executed || !params.change) {
    return {
      state: "failed",
      report: params.failure
        ? `I could not make that change: ${params.failure}`
        : "I could not make that change, so nothing on your site has moved.",
    };
  }
  if (!params.change.changed) {
    return { state: "not_changed", report: reportChange(params.change) };
  }
  if (params.rendered === false) {
    // The most dangerous case, and the one that was silently true for months:
    // the value changed and the page did not.
    return {
      state: "failed",
      report:
        `${reportChange(params.change)} But the page is still not showing it, so something between the ` +
        `setting and your site is not applying it. I would rather tell you that than say it is done.`,
    };
  }
  if (params.rendered === null) {
    return {
      state: "changed_but_unverified",
      report: `${reportChange(params.change)} I could not check the live page just now, so have a look and tell me if you cannot see it.`,
    };
  }
  return { state: "verified", report: reportChange(params.change) };
}
