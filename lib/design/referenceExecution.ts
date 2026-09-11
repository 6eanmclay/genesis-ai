import { actionableProposals, type ReferenceReading } from "./referenceObservation";
import { REFINABLE_DIMENSIONS, type RefinableDimensionKey } from "@/lib/storefront/dimensions";

/**
 * WHAT THE OWNER APPROVED, DECIDED ON THE SERVER.
 *
 * ============ THE CLIENT SENDS INDEXES, NOT CHANGES (2026-09-10) ======
 *
 * Sean: "The execution payload must come from the same validated
 * actionableProposals that the approval surface displayed."
 *
 * The strongest way to hold that is to make the client incapable of supplying
 * a change at all. It sends numbers; the server re-reads the stored reading,
 * re-runs the SAME gate the card was built from, and resolves those numbers
 * against the result. A tampered request can therefore only ever select a
 * different subset of what J4 actually proposed - it cannot introduce a
 * dimension, a value, or a proposal the owner was never shown.
 *
 * That closes four of Sean's requirements in one mechanism rather than four
 * checks that could each be forgotten:
 *
 *   bearsOn: null cannot execute      it never enters actionableProposals
 *   invalid values cannot execute     same
 *   unbacked proposals cannot execute same
 *   mismatched citations cannot       same
 *
 * ============ AND NOTHING IS APPROVED BY DEFAULT =====================
 *
 * Sean: "Do not infer approval from opening the card, viewing it, selecting
 * it, or submitting the reference."
 *
 * So an empty selection is a refusal, not a no-op that quietly applies
 * everything, and there is no "all" shortcut anywhere in this file. The card
 * starting with boxes ticked is a convenience for the eye; nothing executes
 * until the owner presses a control whose only job is to say yes.
 */

export interface ApprovedExecution {
  /** Exactly what will be applied. Resolved server-side from the gate. */
  refinements: { dimension: string; value: string }[];
  /** Owner-facing names, for the report. */
  requested: string[];
  /** Selections that resolved to nothing, named rather than dropped. */
  ignored: number[];
}

export type ApprovalOutcome =
  | { approved: true; execution: ApprovedExecution }
  | { approved: false; because: string };

/**
 * Resolve an owner's selection against the reading they were shown.
 *
 * Pure. Takes the stored reading and the indexes the client sent, and returns
 * only what the gate already approved.
 */
export function approveSelection(
  reading: ReferenceReading,
  selectedIndexes: number[],
): ApprovalOutcome {
  const actionable = actionableProposals(reading);
  if (actionable.length === 0) {
    return {
      approved: false,
      because: "There is nothing in that reference I can act on, so there is nothing to apply.",
    };
  }

  const unique = [...new Set(selectedIndexes)].filter((i) => Number.isInteger(i));
  const valid = unique.filter((i) => i >= 0 && i < actionable.length).sort((a, b) => a - b);
  const ignored = unique.filter((i) => i < 0 || i >= actionable.length);

  if (valid.length === 0) {
    // NOT "apply everything". An empty or nonsense selection is the owner
    // having chosen nothing, and choosing nothing is a real answer.
    return {
      approved: false,
      because: "Nothing was selected, so nothing has been changed. Tick the changes you want and try again.",
    };
  }

  return {
    approved: true,
    execution: {
      refinements: valid.map((i) => ({
        dimension: actionable[i].dimension,
        value: actionable[i].value,
      })),
      requested: valid.map(
        (i) => `${REFINABLE_DIMENSIONS[actionable[i].dimension as RefinableDimensionKey].label} → ${actionable[i].value}`,
      ),
      ignored,
    },
  };
}

/**
 * WHAT J4 SAYS AFTERWARDS, and the four things it must keep apart.
 *
 * Sean: the report must distinguish "what was requested, what was actually
 * executed, what verification observed, and whether the change succeeded" -
 * and "if execution fails, J4 must say it failed rather than describing the
 * intended change as completed."
 *
 * Those are four different facts and this codebase has already been burned by
 * merging them: on 2026-09-05 eight refine_storefront executions failed on
 * invented values and J4 told Sean the storefront had been given "a more
 * characterful headline font". The request became the report.
 *
 * So the report is DERIVED from the outcome rather than written beside it, and
 * `succeeded` is computed from what actually happened - it is not a field a
 * caller can set.
 */
export interface ExecutionReport {
  requested: string[];
  executed: string[];
  /** What a rendered check saw, or null when none could run. */
  observed: string | null;
  succeeded: boolean;
  /** The sentence for the owner. Derived, never supplied. */
  sentence: string;
}

export function reportFor(params: {
  requested: string[];
  /** Empty when the execution did not apply anything. */
  executed: string[];
  /** True/false from a REAL rendered check; null when none could run. */
  rendered: boolean | null;
  failure?: string | null;
}): ExecutionReport {
  const executed = params.executed;
  const succeeded = executed.length > 0 && params.rendered !== false && !params.failure;

  let sentence: string;
  if (params.failure || executed.length === 0) {
    // SAYS IT FAILED. The requested change is named so the owner knows what
    // did not happen, and never in the past tense.
    sentence =
      `I could not make ${params.requested.length === 1 ? "that change" : "those changes"}` +
      `${params.failure ? `: ${params.failure}` : ""}. Nothing on your storefront has moved.`;
  } else if (params.rendered === false) {
    // THE MOST DANGEROUS CASE, and the one that was silently true for months:
    // the value changed and the page did not.
    sentence =
      `I changed ${executed.join(", ")}, but your live page is still not showing it. ` +
      `Something between the setting and your site is not applying it, and I would rather tell you that than say it is done.`;
  } else if (params.rendered === null) {
    sentence =
      `I changed ${executed.join(", ")}. I could not check the live page just now, so have a look and tell me if you cannot see it.`;
  } else {
    sentence = `I changed ${executed.join(", ")}, and I can see it on your live page.`;
  }

  return {
    requested: params.requested,
    executed,
    observed:
      params.rendered === true ? "the rendered page shows the change"
      : params.rendered === false ? "the rendered page does NOT show the change"
      : null,
    succeeded,
    sentence,
  };
}
