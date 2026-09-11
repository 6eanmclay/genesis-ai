import type { BusinessUnderstanding } from "@/lib/businessModel/understanding";
import { ASSET_ROLES } from "@/lib/businessModel/assets";
import { actionForNeed, type BusinessNeed } from "./ownerCapability";
import { officeActionForExplanation, type OfficeAction } from "./officeActions";
import type { BriefingItem, HandledSummary } from "./officeBriefing";

/**
 * WHAT WE SHOULD DO ABOUT THE BUSINESS, DERIVED FROM WHAT WE KNOW ABOUT IT.
 *
 * ============ THE DECISION THIS IMPLEMENTS (Sean, 2026-09-10) ==========
 *
 * "BusinessUnderstanding is the canonical model of what is true/known about
 * the business. OfficeWork is a separate, pure work layer derived from
 * BusinessUnderstanding plus the current working state. Office is the
 * presentation/action surface."
 *
 * And the constraint that gives this file its shape: "Do NOT try to stuff
 * volatile Office work into BusinessUnderstanding just to make everything come
 * from one object. The Map/Understanding model and the owner's active work are
 * genuinely different kinds of information."
 *
 * ============ WHY THIS IS NOT A SECOND ASSEMBLER ======================
 *
 * BUSINESS_UNDERSTANDING_CONTRACT.md invariant 1: "getBusinessUnderstanding is
 * the only thing that composes providers into an understanding. A second
 * assembler is a defect."
 *
 * The distinction is not a promise, it is the signature. This module COMPOSES
 * NOTHING - it receives a BusinessUnderstanding that somebody else assembled,
 * as an argument. It cannot fetch, because it has no prisma import and no
 * provider import, and `verify-office-work.ts` asserts that about the source
 * rather than trusting the current wiring.
 *
 * That is the property buildChatDataContext did not have. It fetched for
 * itself - 24 parallel queries, two of them duplicating the canonical model -
 * which is what made it a second assembler rather than a consumer. A function
 * whose business knowledge arrives through its parameters cannot drift from
 * the canonical model, because it has no independent way to learn anything.
 *
 * ============ AND IT REALLY USES THE UNDERSTANDING =====================
 *
 * Taking an argument and ignoring it would be the same architecture on paper
 * and none of it in fact. Two things here come from the canonical model and
 * from nowhere else:
 *
 *   explanations   understanding.activeThoughts, filtered to kind
 *                  "explanation". The Office used to read cognitiveOutput a
 *                  SECOND time for these; the canonical select now carries
 *                  actionHref, so the second read has nothing left to fetch.
 *
 *   needs          derived from profile.offerings and currentAssets. A store
 *                  listing products with no photograph on record is the
 *                  evidence for the photography need - a fact about the
 *                  business, read from the model of the business.
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

/**
 * The volatile half: what is outstanding right now.
 *
 * Deliberately NOT part of BusinessUnderstanding. "There are two decisions
 * waiting" is true for an afternoon; "this business sells three products" is
 * true until the owner changes it. Folding the first into the second would
 * make the Map's input churn every time a task closed.
 */
export interface WorkingState {
  decisions: BriefingItem[];
  observations: BriefingItem[];
  tasks: BriefingItem[];
  handled: HandledSummary;
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
 * `internal` returns null and renders nowhere - the rule officeActions.ts
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

/** The items in one section. A filter, never a second query. */
export function itemsIn(work: OfficeWork, section: OfficeSection): WorkItem[] {
  return work.items.filter((i) => sectionFor(i.action) === section);
}

/**
 * The needs this business actually has, read from what is known about it.
 *
 * Grounded, not guessed. Each entry names the fact in the canonical model that
 * makes it true, and a need with no evidence is simply not returned - J4 does
 * not ask an owner for photographs of products they do not sell.
 *
 * One need today. Sean: "no speculative refactoring." A second is added when
 * there is a fact in the model that evidences it, not because the list looks
 * short.
 */
export function needsFor(understanding: BusinessUnderstanding): BusinessNeed[] {
  const needs: BusinessNeed[] = [];

  // PRODUCTS LISTED, NO PHOTOGRAPH ON RECORD. J4 can generate images and
  // cannot photograph the real object, which is the boundary exactly.
  const sellsSomething = understanding.profile.offerings.activeCount > 0;
  const hasPhotograph = Boolean(understanding.currentAssets[ASSET_ROLES.productPhoto]);
  if (sellsSomething && !hasPhotograph) {
    needs.push({
      id: "product_photography",
      what: "photographs of what you actually make",
      boundary: "photograph_physical_object",
      provideAt: { section: "/dashboard/products", label: "Add photographs" },
    });
  }

  return needs;
}

/**
 * The Office's work, derived.
 *
 * Pure. Same inputs, same output, no clock and no database.
 */
export function officeWork(
  understanding: BusinessUnderstanding,
  state: WorkingState,
  basePath: string,
): OfficeWork {
  const items: WorkItem[] = [];

  // FROM THE CANONICAL MODEL. These used to be a second read of a table the
  // assembler was already reading.
  for (const thought of understanding.activeThoughts) {
    if (thought.kind !== "explanation") continue;
    items.push({
      id: thought.id,
      headline: thought.summary,
      why: null,
      standingDays: null,
      action: officeActionForExplanation({ actionHref: thought.actionHref }, basePath),
    });
  }

  // FROM THE CANONICAL MODEL, as capability gaps.
  for (const need of needsFor(understanding)) {
    items.push({
      id: `need:${need.id}`,
      headline: need.what,
      why: null,
      standingDays: null,
      action: actionForNeed(need, basePath),
    });
  }

  // FROM THE WORKING STATE. Already carrying their own actions, decided by the
  // rules in officeActions.ts - this does not re-decide one of them.
  for (const item of [...state.decisions, ...state.observations, ...state.tasks]) {
    items.push({
      id: item.id,
      headline: item.headline,
      why: item.why,
      standingDays: item.standingDays,
      action: item.action,
    });
  }

  return { items, handled: state.handled };
}
