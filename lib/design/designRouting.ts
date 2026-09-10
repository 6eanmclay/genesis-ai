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
 * ============ AMBIGUITY IS AN ANSWER (Sean, 2026-09-10) ================
 *
 * "Keep classifyDesignRequest conservative for now. Do not make it guess. If
 * the request is ambiguous, don't silently route it to an unrelated design
 * action. Ask a clarification question or have J4 explain what it thinks the
 * owner is asking for. That's much better than another version of the current
 * problem where J4 confidently executes the wrong thing."
 *
 * So there are three outcomes rather than two, and the middle one is the point:
 *
 *   confident     the request names a property. Route it, and refuse any
 *                 action that cannot change that property.
 *   ambiguous     the request is plainly about the design and plainly does
 *                 NOT name a property. J4 asks rather than picks.
 *   unclassified  not a design request at all, or nothing this can tell.
 *                 The model routes it exactly as it always did.
 *
 * The distinction between `ambiguous` and `unclassified` is what stops this
 * from becoming the original defect wearing a new coat. Silence about a
 * request it cannot read is honest; a guess is how "make it warmer" became
 * eight failed executions and a claim of success.
 */
export type DesignRequest =
  | { kind: "confident"; properties: DesignProperty[] }
  | { kind: "ambiguous"; candidates: DesignProperty[]; question: string }
  | { kind: "unclassified" };

/** The properties a request names, or none when it does not name any. */
export function propertiesOf(request: DesignRequest): DesignProperty[] {
  return request.kind === "confident" ? request.properties : [];
}

// Words that say "I want the design changed" without saying what.
const VAGUE_DESIGN = /\b(look|looks|looking|feel|feels|vibe|style|design|prettier|nicer|better|elegant|modern|alive|boring|basic|bland|plain|cleaner|warmer|fresher)\b/;
// Words that name a surface but not a property.
const SURFACE = /\b(website|site|homepage|home page|page|storefront|shop)\b/;

export function classifyDesignRequest(text: string): DesignRequest {
  const t = text.toLowerCase();

  // TYPOGRAPHY, named outright. "font size" is excluded deliberately - a scale
  // is something refine_storefront genuinely can change.
  const namesFont = /\b(font|typeface|lettering)\b/.test(t) && !/\bfont size\b|\bsize of the font\b/.test(t);
  if (namesFont) {
    const heading = /\b(heading|headline|title|header)s?\b/.test(t);
    const body = /\b(body|paragraph|text|copy)\b/.test(t);
    if (heading && !body) return { kind: "confident", properties: [{ group: "typography", field: "headingFont" }] };
    if (body && !heading) return { kind: "confident", properties: [{ group: "typography", field: "bodyFont" }] };
    return {
      kind: "confident",
      properties: [
        { group: "typography", field: "headingFont" },
        { group: "typography", field: "bodyFont" },
      ],
    };
  }

  // PLAINLY ABOUT THE DESIGN, PLAINLY NOT SPECIFIC. This is the case that used
  // to be executed as whatever was nearest to hand.
  if (VAGUE_DESIGN.test(t) && SURFACE.test(t)) {
    return {
      kind: "ambiguous",
      candidates: [
        { group: "typography", field: "headingFont" },
        { group: "colors", field: "background" },
        { group: "composition", field: "heroLayout" },
      ],
      question:
        "Before I change anything — is it the type, the colours, or the layout that is bothering you? " +
        "I would rather change the thing you meant than the thing I can reach quickest.",
    };
  }

  return { kind: "unclassified" };
}

/**
 * WHETHER A DESIGN MUTATION MAY RUN AT ALL.
 *
 * The gate the three states exist for. Note which way each one falls:
 *
 *   confident + capable    allowed
 *   confident + incapable  refused, with the reason the owner gets told
 *   ambiguous              refused, with a QUESTION instead of a change
 *   unclassified           ALLOWED
 *
 * That last row is deliberate and is the one most likely to be "tidied" into
 * a refusal later. This classifier reads a narrow band of requests; most of
 * what reaches an executable it cannot read at all, and a gate that blocked
 * everything it did not recognise would break every design change J4 makes
 * rather than only the wrong ones. Silence means "I have nothing to add",
 * never "I forbid it".
 */
export function mayExecuteDesignMutation(
  request: DesignRequest,
  action: OwningAction,
):
  | { allowed: true; properties: DesignProperty[] }
  | { allowed: false; because: string; ask: string | null } {
  if (request.kind === "ambiguous") {
    return {
      allowed: false,
      because: "the request is about the design but does not say which part, and guessing is what produced the last defect",
      ask: request.question,
    };
  }
  if (request.kind === "unclassified") {
    return { allowed: true, properties: [] };
  }
  const wrong = cannotSatisfy(action, request.properties);
  if (wrong.length > 0) {
    return { allowed: false, because: explainWrongAction(wrong, action), ask: null };
  }
  return { allowed: true, properties: request.properties };
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
