import { officeActionForObservation, officeActionForExecution, type OfficeAction } from "./officeActions";

/**
 * WHAT J4 LEADS WITH WHEN THE OWNER WALKS IN.
 *
 * ============ WHAT THIS EXISTS TO END (2026-09-09) =====================
 *
 * The Office opened on `activeCategory = "conversation"`. Measured on Cubit &
 * Coil, that meant **40 items J4 already knew, loaded on every visit, and none
 * of them on screen**: 8 ideas, 11 problems, 20 explanations, 1 decision
 * waiting. The owner had to guess which tab held the thing that mattered.
 *
 * Sean: "When the owner enters Office, J4 should immediately surface what
 * matters... Do not simply add another tab or another dashboard card. The
 * intelligence should come forward and become the primary Office experience."
 *
 * ============ AN ORDER, NOT A SCORE ====================================
 *
 * The obvious way to rank these is a number - urgency 0-100, a priority score,
 * a health index. Every one of those invents a quantity nobody computed, which
 * is the "Business Health 87" failure in a new place, and it cannot be
 * explained to the owner because there is nothing behind it.
 *
 * So this is a fixed ORDER of five kinds, each of which is a real distinction
 * an owner would make themselves:
 *
 *   1. A decision J4 has prepared and is blocked on   - he is waiting on YOU
 *   2. A problem you can do something about           - broken, and fixable
 *   3. A problem you cannot yet act on                - broken, and it says so
 *   4. An opportunity with somewhere to go            - not broken, worth doing
 *   5. An opportunity with nowhere to go yet          - noted, honestly inert
 *
 * Within a kind, longest-standing first, because "this has been true for six
 * weeks" is a fact about the world rather than a weight I chose. That is the
 * whole ranking. It can be explained in one sentence to the owner, which is
 * the test a score would fail.
 *
 * ============ WHY IT MATTERS COMES FROM REAL FIELDS ====================
 *
 * `why` is never generated prose. For a decision it is `ApprovalRequest.
 * rationale` - J4's own reasoning, which the loader already read from the
 * database and then dropped before it reached a screen. For an observation it
 * is how long the condition has been true, from `firstNoticedAt`. When there
 * is neither, `why` is null and the surface shows nothing rather than filling
 * the space with something plausible.
 *
 * ============ THE ACTION-LAYER RULE IS NOT RELAXED =====================
 *
 * Sean: "Internal execution events must not automatically become owner-facing
 * attention items." The handled/changed summary reads the SAME
 * officeActionForExecution rule the attention path uses. Measured over 14 days
 * on Cubit & Coil that is the difference between 238 successful executions and
 * the ~20 that concern an owner: 117 `genesis.communicate_finding`, 29 chat
 * turns and 8 internal review runs are not news, and a briefing that led with
 * them would be a log file with a headline.
 */

/**
 * ============ THE RULE THIS SERVES (Sean, 2026-09-09) ==================
 *
 *   If J4 knows it            -> surface it.
 *   If it matters             -> explain why.
 *   If something can be done  -> make it actionable.
 *   If the owner approves     -> execute it for real.
 *   If it executes            -> report the result back into J4's
 *                                understanding.
 *
 * Written here rather than in a document because this module is where the
 * first three are decided, and because the fourth and fifth are the ones a
 * refactor could quietly drop: a button that runs a server action and then
 * goes silent still looks like it worked.
 *
 * Where each lives:
 *   1. buildBriefing puts EVERY active item on the arrival surface.
 *   2. `why` comes from ApprovalRequest.rationale or firstNoticedAt, or is
 *      null and renders as nothing.
 *   3. officeActions.ts decides the action; nothing here re-decides it.
 *   4. the Approve button calls approveProposalInConversation, the same
 *      server action the conversation uses - not a briefing-shaped copy.
 *   5. that action writes J4's own account of the outcome back as a message,
 *      and the execution itself changes the business records the
 *      understanding is built from. verify-office-arrival proves the loop
 *      end to end in a browser: settled, reported, and gone from the list.
 *
 * WHAT IT FORBIDS, in the same breath: no second health score, no generated
 * summary standing in for a real one, no parallel intelligence layer beside
 * the business knowledge that already exists.
 */

/** Which of the five kinds an item is. The order below IS the priority. */
export type BriefingKind =
  | "decision"
  | "problem_actionable"
  | "problem_inert"
  | "opportunity_actionable"
  | "opportunity_inert";

/** The order. Index is priority; nothing else decides it. */
export const BRIEFING_ORDER: readonly BriefingKind[] = [
  "decision",
  "problem_actionable",
  "problem_inert",
  "opportunity_actionable",
  "opportunity_inert",
] as const;

export interface BriefingItem {
  id: string;
  kind: BriefingKind;
  /** What J4 found, in his words. Never rewritten here. */
  headline: string;
  /**
   * Why it matters, from a real field or not at all.
   *
   * Null is a legitimate answer and must render as nothing, not as filler.
   */
  why: string | null;
  /** How long this has been true, when the row records it. */
  standingDays: number | null;
  /** What the owner can do, decided by lib/j4/officeActions.ts. */
  action: OfficeAction;
}

export interface HandledSummary {
  /** Conditions J4 saw clear on their own, without troubling the owner. */
  resolvedByJ4: number;
  /** Decisions the owner settled. */
  decisionsSettled: number;
  /** Real changes to the business, internal executions excluded. */
  changes: { action: string; label: string; n: number }[];
  /** How far back this looks, so the number is never a bare figure. */
  windowDays: number;
}

export interface BriefingInput {
  decisions: { id: string; summary: string; rationale?: string | null; createdAt: Date | string }[];
  observations: {
    id: string;
    summary: string;
    genesisState: string;
    actionHref?: string | null;
    firstNoticedAt?: Date | string | null;
  }[];
  now?: Date;
}

function daysSince(value: Date | string | null | undefined, now: Date): number | null {
  if (!value) return null;
  const then = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(then.getTime())) return null;
  const days = Math.floor((now.getTime() - then.getTime()) / 86_400_000);
  return days >= 0 ? days : null;
}

/**
 * How long a thing has been true, said the way a person would say it.
 *
 * Deliberately vague past a fortnight: "noticed 47 days ago" is a precision
 * that implies a precision about when it STARTED, and firstNoticedAt only
 * records when J4 first saw it.
 */
export function standingFor(days: number | null): string | null {
  if (days === null) return null;
  if (days <= 0) return "noticed today";
  if (days === 1) return "since yesterday";
  if (days < 14) return `standing for ${days} days`;
  if (days < 60) return "standing for weeks";
  return "standing for months";
}

/** Build the arrival briefing. Pure: every input is already loaded. */
export function buildBriefing(input: BriefingInput, basePath: string): BriefingItem[] {
  const now = input.now ?? new Date();
  const items: BriefingItem[] = [];

  for (const d of input.decisions) {
    items.push({
      id: d.id,
      kind: "decision",
      headline: d.summary,
      // The rationale, or nothing. Never a stand-in sentence.
      why: d.rationale?.trim() ? d.rationale.trim() : null,
      standingDays: daysSince(d.createdAt, now),
      // A decision is settled here, not navigated to. approveGenesisAction is
      // the same server action the conversation already uses.
      // A pending approval is a real choice with alternatives, so it offers a
      // DECISION rather than work to release. That is what files it under
      // DECIDE rather than READY TO GO.
      action: { kind: "execute", label: "Approve", intent: "approve", offer: "decide" },
    });
  }

  for (const o of input.observations) {
    const action = officeActionForObservation(o, basePath);
    const isProblem = o.genesisState === "urgent";
    const actionable = action.kind === "open";
    const days = daysSince(o.firstNoticedAt, now);
    items.push({
      id: o.id,
      kind: isProblem
        ? actionable
          ? "problem_actionable"
          : "problem_inert"
        : actionable
          ? "opportunity_actionable"
          : "opportunity_inert",
      headline: o.summary,
      why: standingFor(days),
      standingDays: days,
      action,
    });
  }

  return items.sort((a, b) => {
    const byKind = BRIEFING_ORDER.indexOf(a.kind) - BRIEFING_ORDER.indexOf(b.kind);
    if (byKind !== 0) return byKind;
    // Longest-standing first WITHIN a kind. A null standing sorts last: not
    // knowing how long something has been true is not the same as it being new.
    if (a.standingDays === null && b.standingDays === null) return 0;
    if (a.standingDays === null) return 1;
    if (b.standingDays === null) return -1;
    return b.standingDays - a.standingDays;
  });
}

/**
 * What J4 already handled, and what actually changed.
 *
 * `successes` are raw ExecutionLog rows. They are filtered through the same
 * rule the attention path uses, so an internal event cannot become news here
 * either - which is the constraint Sean restated when approving this slice.
 */
export function summariseHandled(
  input: {
    resolvedByJ4: number;
    decisionsSettled: number;
    successes: { action: string; message: string }[];
    windowDays: number;
  },
  basePath: string,
): HandledSummary {
  const counts = new Map<string, { label: string; n: number }>();
  for (const s of input.successes) {
    const decision = officeActionForExecution(s, basePath);
    if (decision.kind !== "open") continue;
    const cur = counts.get(s.action) ?? { label: decision.label, n: 0 };
    cur.n += 1;
    counts.set(s.action, cur);
  }
  return {
    resolvedByJ4: input.resolvedByJ4,
    decisionsSettled: input.decisionsSettled,
    changes: [...counts]
      .map(([action, v]) => ({ action, label: v.label, n: v.n }))
      .sort((a, b) => b.n - a.n),
    windowDays: input.windowDays,
  };
}

/**
 * Which surface leads with a briefing.
 *
 * ============ ONE PREDICATE, READ BY THE FETCH AND THE RENDER ==========
 *
 * J4Surface.tsx carries a warning earned by two real bugs: `isRoom` was
 * deleted rather than left lying around, because "a ready-made 'the layer is
 * the lesser surface' flag is what the last two bugs were built on." Both were
 * the same shape - the surface started showing something and one upstream read
 * still assumed the old split, so the view rendered its empty state no matter
 * how much data the store had.
 *
 * The briefing genuinely is Office-only: the layer is a panel summoned over
 * the owner's work to talk, and it opens on the conversation. So there IS a
 * gate. What there is not is a second opinion about it - the fetch in
 * J4Surface and the render in J4Workspace both call this, so the day the layer
 * grows a briefing, one edit here moves both.
 *
 * That is the same fix the dock and the navigation got: not "remember to keep
 * them in step", but "there is only one of them".
 */
export function surfaceShowsBriefing(surface: string): boolean {
  return surface === "room";
}

/** Whether there is anything at all to lead with. */
export function briefingIsEmpty(items: BriefingItem[], handled: HandledSummary): boolean {
  return items.length === 0 && handled.resolvedByJ4 === 0 && handled.changes.length === 0;
}
