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

export interface OfficeFactInput {
  activeProducts: number;
  openTasks: number;
  pendingDecisions: number;
  opportunities: number;
  needsYou: number;
  /** How many areas of the business J4 has anything at all about. */
  understandingKnown: number;
  understandingTotal: number;
}

/**
 * The Office strip.
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
      target: { kind: "route", href: `${basePath}/products` },
      source: "active products in your catalogue",
    },
    {
      label: "Opportunities",
      value: input.opportunities,
      target: { kind: "view", view: "ideas" },
      source: "things J4 noticed that could be worth doing",
    },
    {
      label: "Needs you",
      value: input.needsYou,
      target: { kind: "view", view: "information" },
      source: "problems J4 found that are waiting on you",
    },
    {
      label: "Decisions",
      value: input.pendingDecisions,
      target: { kind: "view", view: "decisions" },
      source: "actions J4 has prepared and is holding for your approval",
    },
    {
      label: "Tasks",
      value: input.openTasks,
      target: { kind: "view", view: "tasks" },
      source: "open work items",
    },
    {
      label: "Known",
      value: input.understandingKnown,
      target: { kind: "view", view: "understanding" },
      source: `areas of your business J4 has anything about, of ${input.understandingTotal}`,
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
