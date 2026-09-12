import type { OfficeAction } from "./officeActions";
import type { ObservationState } from "@/lib/dashboard/genesisObservations";

/**
 * A task's health, as lib/dashboard/tasks.ts already types it.
 *
 * Restated here rather than imported because this module must keep ZERO value
 * imports (see verify-office-work), and re-exporting through a type-only
 * import of a prisma-touching module is a rule this file should not have to
 * rely on. verify-office-work asserts the two stay identical.
 */
export type TaskPriority = "FAILED" | "WARNING" | "opportunity";
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
  /**
   * WHAT THIS ITEM ACTUALLY IS — carried, never inferred (2026-09-12).
   *
   * ============ WHY TWO FIELDS AND NOT ONE ==========================
   *
   * `action` says what the owner can DO about an item. It does not say what
   * the item IS, and the Office has always needed both: its sections filter
   * by response (needs you / ready to go / decide / noticed) while its
   * category views filter by kind (Tasks / Ideas / Decisions / Information).
   * Those are orthogonal axes, and for one migration this list carried only
   * the first.
   *
   * The cost was exact. officeActionForObservation receives
   * `{ actionHref, summary }` and never sees genesisState, so an opportunity
   * and an urgent observation with hrefs produce byte-identical items, and
   * without hrefs both collapse to the same `none`. Explanations and tasks
   * did the same to each other. Four categories could not be rebuilt from
   * this list, which is why the legacy arrays could not be deleted.
   *
   * Neither field is new vocabulary. Both are facts the pipeline already had
   * and dropped at this boundary — the same "evidence computed, then
   * discarded at the last step" shape this codebase keeps finding.
   *
   * Deliberately NOT a `source` taxonomy. Sean: these are existing semantic
   * facts, not an invented classification, and a fifth vocabulary naming the
   * producers would be exactly the parallel model this migration removes.
   */
  genesisState: ObservationState | null;
  /**
   * The CognitiveOutput kind, for items that are one. "explanation" is the
   * value that matters — it is what officeWork already reads to decide an
   * activeThought belongs here at all, and then threw away.
   *
   * Null for everything that is not a CognitiveOutput, which is how a task
   * with a `none` action stays distinguishable from an inert explanation.
   */
  cognitiveKind: string | null;
  /**
   * A Task's own priority, for items that are tasks.
   *
   * ITS OWN FIELD, AND DELIBERATELY NOT FOLDED INTO genesisState. Both
   * vocabularies contain the word "opportunity" and they mean different
   * things: an observation's state is J4's read of a business condition, a
   * task's priority is the health of a piece of work. Merging them because
   * two strings match would be inventing a shared meaning neither has.
   *
   * Carried because the Office renders it: FAILED is red, WARNING amber,
   * opportunity purple. Without it every task draws purple and a FAILED task
   * becomes indistinguishable from an opportunity — semantic information lost
   * in the move from a legacy array into this list, which is exactly what
   * this representation exists to prevent.
   */
  taskPriority: TaskPriority | null;
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

/**
 * The Office's category views, as filters over the one list.
 *
 * ============ THE OTHER AXIS (2026-09-12) =============================
 *
 * `sectionFor` answers "what response does this need" — needs you, ready to
 * go, decide, noticed. This answers "what IS it" — the axis the four category
 * tabs have always used. Both are filters over the same items now; before
 * this, the second axis lived in six parallel arrays assembled separately,
 * which is how the Office came to hold two representations of one thing.
 *
 * Every branch reads a fact the item CARRIES. Nothing here parses an id,
 * inspects an href, or depends on the order items were pushed. The one place
 * an action is consulted is `decide`, which is the decision layer's own
 * classification and the semantics Sean kept deliberately.
 *
 * `needs` returns null: a capability gap is real work and appears in the
 * NEEDS YOU section, but it was never one of the four category views, and
 * quietly filing it under Tasks would invent a membership it never had.
 */
export type OfficeCategory = "tasks" | "ideas" | "decisions" | "information";

export function categoryFor(item: WorkItem): OfficeCategory | null {
  // A pending approval — the action layer's own answer, and the SAME
  // expression sectionFor uses to place it in DECIDE. There is no "decide"
  // action kind; a decision is an `execute` action whose offer is "decide",
  // and asking the question a second way here is how two rails start
  // disagreeing about one row.
  if (item.action.kind === "execute" && item.action.offer === "decide") return "decisions";
  // An observation, by its own state — never by whether it happens to have
  // somewhere to go. An opportunity with no href is still an opportunity.
  if (item.genesisState === "opportunity") return "ideas";
  if (item.genesisState === "urgent") return "information";
  // An explanation, by the discriminator officeWork already used to admit it.
  if (item.cognitiveKind === "explanation") return "information";
  // A capability gap: real work, no category view. Identified by the action
  // layer, like a decision.
  if (item.action.kind === "needs_owner") return null;
  // What remains is a task, and it says so by carrying a task's own field.
  if (item.taskPriority !== null) return "tasks";
  return null;
}

/** The items in one category view. The counterpart of itemsIn for sections. */
export function inCategory(work: { items: WorkItem[] }, category: OfficeCategory): WorkItem[] {
  return work.items.filter((item) => categoryFor(item) === category);
}

/**
 * The dot colour an item carries into a category row.
 *
 * Here rather than in the component because it is the rendered consequence of
 * the semantic facts above, and the whole point of carrying them is that a
 * FAILED task cannot come out the same colour as an opportunity.
 */
export function categoryDotFor(item: WorkItem): string {
  if (item.taskPriority === "FAILED") return "bg-red-500";
  if (item.taskPriority === "WARNING") return "bg-amber-400";
  if (item.taskPriority === "opportunity") return "bg-purple-500";
  if (item.action.kind === "execute" && item.action.offer === "decide") return "bg-amber-400";
  if (item.genesisState === "opportunity") return "bg-purple-500";
  if (item.genesisState === "urgent") return "bg-red-500";
  if (item.cognitiveKind === "explanation") return "bg-teal-400";
  return "bg-zinc-500";
}
