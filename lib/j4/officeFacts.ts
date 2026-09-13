// NO IMPORTS LEFT, and that is the shape of the change (2026-09-13). This
// module took the work list so it could derive "Needs you" from the same
// `itemsIn` the sections use. With that count gone — the section below owns
// it — there is nothing here that depends on the work at all: the strip is
// business facts, and the work list is the work list.

/**
 * WHAT J4 ACTUALLY KNOWS, AS NUMBERS THAT CAME FROM SOMEWHERE.
 *
 * ============ WHY EVERY FACT CARRIES ITS SOURCE (2026-09-09) ===========
 *
 * The Office references Sean supplied show a command centre with a numbers
 * strip: "Business Health 87", "Customers 2,340", "Financials $117.63",
 * "J4 is analyzing your business... 68%". Cubit & Coil does not have 2,340
 * customers, there is no calculation behind 87, and nothing is 68% done.
 *
 * Sean had already ruled on this once, before these references existed:
 * "Remove invented metrics such as 'Business Health 87' unless there is an
 * actual underlying calculation and source." And on the references themselves:
 * "The images I supplied are not requests to copy every piece of artwork
 * literally. They communicate the intended visual hierarchy and experience."
 *
 * So the strip is real, and the type is what makes it real: a fact cannot be
 * constructed without naming where its number came from. `source` is not
 * decoration and not a tooltip - it is the field that makes an invented metric
 * impossible to add without writing down a lie somebody can read.
 *
 * ============ THESE ARE J4'S FINDINGS, NOT VANITY NUMBERS ==============
 *
 * "Customers: 2,340" tells an owner nothing they can act on. What belongs in
 * J4's office is what J4 has found and what is waiting on the owner - so every
 * fact here is either a real count of the business, or a count of work J4 is
 * holding for them. Each one leads somewhere real, which is the same rule the
 * rows follow (see officeActions.ts).
 */

export interface OfficeFact {
  /** What the owner reads. */
  label: string;
  /** The number itself. Never estimated, never rounded up for effect. */
  value: number;
  /**
   * Where the owner goes.
   *
   * A discriminated target rather than a string, because the two destinations
   * are genuinely different acts: a route is a navigation, a view is a change
   * of what this same surface is showing. The first draft encoded views as the
   * pseudo-href "?view=ideas", which is a string that looks like a URL and is
   * not one - precisely the sort of fudge that later gets passed to a router.
   */
  target: { kind: "route"; href: string } | { kind: "view"; view: string };
  /**
   * Where this number came from, in one plain phrase.
   *
   * Required. A fact with no traceable origin is the invented metric this
   * module exists to prevent, and the type refuses to let one be built.
   */
  source: string;
  /** True when the number is zero and that is worth saying rather than hiding. */
  quiet?: boolean;
}

/**
 * The counts that do NOT come from the work list.
 *
 * ============ WHY TWO OF THEM LEFT THIS TYPE (2026-09-11) ==============
 *
 * The strip said "2 NEEDS YOU" directly above a section reading "Nothing is
 * waiting on you right now". Both were green in every suite, because they were
 * different components counting different things through the same two words:
 *
 *   the strip     urgent observations - `needsYou: urgent.length`
 *   the section   items whose action is needs_owner
 *
 * Neither was computing wrongly. They disagreed because "needs you" had two
 * meanings and nothing forced them together, which is the same one-fact-two-
 * paths shape this codebase keeps finding.
 *
 * The fix is not a corrected number, which would drift again the moment either
 * side changed. `needsYou` and `pendingDecisions` are GONE from this type, so a
 * caller can no longer supply them at all - they are derived from the same
 * work list the sections filter, by the same `itemsIn`, and a strip that
 * disagrees with its section is now unrepresentable rather than merely fixed.
 *
 * What stays here is what has no section to agree with: the catalogue, open
 * tasks, and opportunities.
 *
 * ============ AND THEN THE RULE ITSELF (2026-09-13) ====================
 *
 * Sean, closing the same thread for the last time: "If a fact is already
 * owned and counted by an Office destination directly below, the summary
 * strip does not count it again."
 *
 * 6a7f9cc removed Opportunities, Decisions and Tasks on that reasoning. NEEDS
 * YOU was the survivor, and it was the clearest case of all: the strip said
 * "Needs you 0" directly above a section headed NEEDS YOU saying nothing was
 * waiting. Deriving both from one list made them agree; it did not stop them
 * being the same sentence twice.
 *
 * Products stays because a product is a real thing in another room and no
 * Office destination counts it. Nothing was invented to fill the space.
 *
 * THE RULE HAS A SHAPE THE COMPILER CAN NEARLY HOLD, and a suite can: an
 * Office destination is a `view` target, and anything else is a `route`. So
 * "no strip fact may target an Office view" is the rule restated as
 * something checkable — see verify-office-facts, which asserts exactly that
 * rather than a list of banned words.
 */
export interface OfficeFactInput {
  activeProducts: number;
}

/**
 * The Office strip.
 *
 * "KNOWN" MOVED OUT (2026-09-09). The strip used to carry how many areas of
 * the business J4 has any fact about. That count comes from
 * getBusinessUnderstanding, which measured 921ms against production and is now
 * loaded on demand - so keeping it here would have meant paying the single
 * most expensive read in the Office to render one number in a strip.
 *
 * It was moved, not deleted: the Understanding view shows what J4 knows, which
 * is where an owner goes to find out, and it loads when they go there.
 *
 * Category hrefs are the Office's own views rather than other rooms: an
 * opportunity J4 found lives in the Office, and sending the owner to a
 * different room to read it would be the "hunt through unrelated sections"
 * Sean named. Products is a real room because a product is a real thing
 * elsewhere.
 */
export function officeFacts(input: OfficeFactInput, basePath: string): OfficeFact[] {
  const facts: OfficeFact[] = [
    {
      label: "Products",
      value: input.activeProducts,
      // A ROUTE, AND THAT IS THE WHOLE TEST NOW (see the rule above): a
      // product is a real thing in another room, so no Office destination
      // owns this count and the strip is the only place it is said.
      target: { kind: "route", href: `${basePath}/products` },
      source: "active products in your catalogue",
    },
  ];

  return facts.map((f) => ({ ...f, quiet: f.value === 0 }));
}

/** Every fact names its origin. Exported so the suite asserts it rather than trusting it. */
export function everyFactIsSourced(facts: OfficeFact[]): boolean {
  return facts.every((f) => f.source.trim().length > 0 && Number.isFinite(f.value));
}


/**
 * The four words the Office is organised around.
 *
 * From Sean's direction - "The environment should visually communicate
 * PLAN -> CREATE -> EXECUTE -> GROW" - and deliberately a constant rather than
 * copy typed into a component, so the Office and anything later that refers to
 * the same arc cannot drift into saying different words.
 */
export const OFFICE_ARC = ["Plan", "Create", "Execute", "Grow"] as const;
