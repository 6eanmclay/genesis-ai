import type { DesignProperty, OwningAction } from "./designChange";
import { ownerOf } from "./designChange";

/**
 * WHAT THE OWNER ASKED TO CHANGE, AND WHETHER THE CHOSEN ACTION CAN DO IT.
 *
 * ============ TWO SEPARATE BUGS, AND THIS IS THE SECOND ================
 *
 * Sean asked for the distinction to be kept, so it is kept here:
 *
 *   Bug 1  The typography change was really stored and could not RENDER,
 *          because every `font-[var(--font-heading)]` class in the app was
 *          inert - Tailwind v4 needs a `family-name:` hint on an arbitrary
 *          font value. 37 of them. Fixed, and guarded by verify-font-change.
 *
 *   Bug 2  A request to change the font reached refine_storefront, which
 *          CANNOT change typography - its own comment says so: "Colours and
 *          typography are deliberately untouched... a palette or font change
 *          remains update_theme's job". Its vocabulary is card style, button
 *          style, shadow, spacing, hero layout, type SCALE, section layout,
 *          background, image treatment, CTA emphasis. No family anywhere.
 *
 *          So the nearest thing it could touch was a colour or a size, and on
 *          5 September it invented values outside even that vocabulary:
 *          eight FAILED executions, and J4 reported success anyway.
 *
 * This module is bug 2. Sean: "A request to change typography must reach an
 * execution path capable of changing typography... Don't just make the current
 * action accept a font value."
 *
 * ============ IT REFUSES RATHER THAN SUBSTITUTES =======================
 *
 * "J4 should never substitute a nearby change because it is easier to
 * implement." A request this cannot classify returns nothing rather than a
 * guess - an unclassified request goes to the model as it always did, and only
 * a CONFIDENT classification can veto an action. A classifier that guessed
 * would replace a wrong action with a differently wrong one.
 */

/** Which property groups an action is capable of changing. */
const CAPABILITY: Record<OwningAction, DesignProperty["group"][]> = {
  // Mirrors updateTheme.ts: the input IS the Theme, so it can set any of it.
  update_theme: ["typography", "colors", "presentation", "composition"],
  // Mirrors applyRefinementsToTheme, which returns
  // `{ ...current, presentation, composition }` - typography and colours pass
  // through untouched by construction.
  refine_storefront: ["presentation", "composition"],
};

export function canSatisfy(action: OwningAction, property: DesignProperty): boolean {
  return CAPABILITY[action].includes(property.group);
}

/** Every property an action cannot change, for a message that says why. */
export function cannotSatisfy(action: OwningAction, properties: DesignProperty[]): DesignProperty[] {
  return properties.filter((p) => !canSatisfy(action, p));
}

/**
 * What design property a request is about, when that is unambiguous.
 *
 * Deliberately narrow. This is not natural-language understanding - it is a
 * guard against one specific failure, where a request naming a property is
 * executed by an action that cannot change that property. Everything it is not
 * sure about returns [], and the model routes as before.
 */
export function classifyDesignRequest(text: string): DesignProperty[] {
  const t = text.toLowerCase();
  const found: DesignProperty[] = [];

  // TYPOGRAPHY. "font" is the unambiguous word; typeface and lettering are the
  // other two an owner actually uses. "font size" is deliberately excluded -
  // that is a scale, which refine_storefront genuinely can do.
  const wantsFont = /\b(font|typeface|lettering)\b/.test(t) && !/\bfont size\b|\bsize of the font\b/.test(t);
  if (wantsFont) {
    const heading = /\b(heading|headline|title|header)s?\b/.test(t);
    const body = /\b(body|paragraph|text|copy)\b/.test(t);
    if (heading && !body) found.push({ group: "typography", field: "headingFont" });
    else if (body && !heading) found.push({ group: "typography", field: "bodyFont" });
    else {
      // "change the font" with nothing narrowing it means both.
      found.push({ group: "typography", field: "headingFont" });
      found.push({ group: "typography", field: "bodyFont" });
    }
  }

  return found;
}

/**
 * The reason a request cannot be carried out by the action that received it.
 *
 * Said to the owner, so it names the thing they asked for rather than the
 * internal action. Sean: "If it can't make the requested change, it should say
 * so." A sentence that admits the limit is worth more than a success that is
 * not one.
 */
export function explainWrongAction(properties: DesignProperty[], action: OwningAction): string {
  const groups = [...new Set(properties.map((p) => p.group))];
  const what = groups.includes("typography") ? "the font" : groups.join(" and ");
  const right = [...new Set(properties.map(ownerOf))];
  return (
    `That asked me to change ${what}, and the change I was about to make cannot do that — ` +
    `${action === "refine_storefront" ? "storefront refinements only adjust layout and presentation" : "that action does not cover it"}. ` +
    `${right.includes("update_theme") ? "Changing the font means changing the theme, which is a different change." : ""}`
  ).trim();
}
