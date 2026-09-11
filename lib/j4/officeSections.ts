import type { OfficeAction } from "./officeActions";
import type { HandledSummary } from "./officeBriefing";

/**
 * WHERE A THING GOES IN THE OFFICE — AND NOTHING ELSE.
 *
 * ============ WHY THIS IS A SEPARATE FILE (2026-09-11) =================
 *
 * Because the first version was not, and the Office did not render.
 *
 * OfficeBriefing.tsx is a client component. It imported `itemsIn` from
 * officeWork.ts, which value-imports ASSET_ROLES from businessModel/assets.ts,
 * which imports prisma. So asking "which section is this row in" pulled the
 * database client into the browser bundle, and the panel never appeared — no
 * type error, no console error, just a selector that waited thirty seconds for
 * something that was never going to paint.
 *
 * The split follows the actual boundary rather than patching the symptom:
 *
 *   officeSections.ts   the CONTRACT — what a work item is, and which of the
 *                       five states its action puts it in. Pure data and one
 *                       switch. No value imports at all, so there is nothing
 *                       for a bundler to drag anywhere.
 *
 *   officeWork.ts       the DERIVATION — reading a BusinessUnderstanding and
 *                       producing that list. Server-side, and free to import
 *                       whatever it needs.
 *
 * scripts/verify-office-work.ts asserts this file has no value imports, so the
 * next person to add a convenient helper here finds out immediately rather
 * than through a blank panel.
 */

/** Where an item appears in the Office. Derived from its action, never chosen. */
export type OfficeSection = "needs_you" | "ready_to_go" | "decide" | "noticed";

/** One thing in the Office, and what can be done about it. */
export interface WorkItem {
  id: string;
  /** What J4 found, in his words. Never rewritten here. */
  headline: string;
  /** Why it matters, from a real field or not at all. */
  why: string | null;
  /** How long this has been true, when the row records it. */
  standingDays: number | null;
  action: OfficeAction;
}

export interface OfficeWork {
  /**
   * ONE list. Every section is a filter over it.
   *
   * Sean: "make these filters over one OfficeWork/action list, not five
   * independent data queries. The action's own kind must determine where it
   * appears." Five queries is how the seven tabs came to disagree about what
   * was outstanding; one list cannot.
   */
  items: WorkItem[];
  /**
   * DONE, which is genuinely not a filter over the list above.
   *
   * Said plainly rather than forced into the same shape: the other four
   * sections are outstanding work and this is a retrospective summary of work
   * that is finished. Modelling a completed execution as a WorkItem with some
   * inert action would be contorting the type to make a slogan true.
   */
  handled: HandledSummary;
}

/**
 * Which section an action belongs to, and the only thing that decides it.
 *
 * `internal` returns null and renders nowhere — the rule officeActions.ts
 * already holds, restated here as placement rather than as visibility.
 */
export function sectionFor(action: OfficeAction): OfficeSection | null {
  switch (action.kind) {
    // What only the owner can provide. FIRST in the Office, because it is the
    // bottleneck J4 cannot multiply.
    case "needs_owner":
      return "needs_you";
    case "execute":
      return action.offer === "decide" ? "decide" : "ready_to_go";
    // Seen, with somewhere to go or with a reason there is nowhere. Both are
    // things J4 noticed and cannot act on itself.
    case "open":
    case "none":
      return "noticed";
    case "internal":
      return null;
  }
}

/**
 * The items in one section. A filter, never a second query.
 *
 * Structurally typed so this file needs no imports that survive compilation —
 * see the note at the top about what happened when it did.
 */
export function itemsIn<T extends { action: OfficeAction }>(
  work: { items: T[] },
  section: OfficeSection,
): T[] {
  return work.items.filter((i) => sectionFor(i.action) === section);
}
