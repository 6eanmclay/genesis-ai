import { REFINABLE_DIMENSIONS } from "@/lib/storefront/dimensions";
import { actionableProposals, type ReferenceReading } from "./referenceObservation";

/**
 * WHAT THE OWNER SEES, AND WHY IT CANNOT DISAGREE WITH WHAT WOULD HAPPEN.
 *
 * ============ THE TWO THINGS MUST NOT LOOK LIKE ONE (2026-09-10) =======
 *
 * Sean: "The objective is to prove that J4 can show the owner exactly what it
 * saw and what it wants to change, without pretending those two things are the
 * same."
 *
 * So every choice on screen carries its own evidence. Not a recommendation with
 * a justification written underneath it - the OBSERVATION, verbatim, the same
 * sentence the model wrote about the picture before it had decided anything.
 * An owner who disagrees with "the headings are much larger than the body text"
 * can reject the type-scale change on those grounds alone, and an owner who
 * agrees with the observation but not the conclusion can reject it on the
 * other. Collapsing them removes that, and removing it is how a confident
 * sentence comes to stand in for a fact.
 *
 * ============ ONE LIST, NOT A SECOND ONE ==============================
 *
 * Sean: "The approval surface must consume the same validated
 * actionableProposals that the execution path will eventually consume. Do not
 * create a UI-specific representation that can diverge from execution."
 *
 * So `choices` is derived from actionableProposals and carries the index of
 * the proposal it came from. Nothing here re-filters, re-validates or re-orders
 * - a card is a view of the gate's output, and `selectedRefinements` reads the
 * same array back. The failure this forecloses is the one this codebase keeps
 * finding: a screen describing a change the execution would not make.
 *
 * ============ AND IT CANNOT MUTATE ANYTHING ===========================
 *
 * Every function here is pure. There is no prisma import, no server action, no
 * executable. The module cannot write a theme even if a caller asked it to,
 * which is what makes "Show/Choose is non-mutating" a property of the code
 * rather than a promise about the current wiring.
 */

/** One thing the owner can say yes or no to. */
export interface ReferenceChoice {
  /** Position in actionableProposals. The link back to execution. */
  index: number;
  /** The observation, verbatim. What J4 SAW. */
  saw: string;
  /** The dimension's owner-facing label. What J4 CAN CHANGE. */
  label: string;
  /** The value, in the existing vocabulary. Never a colour, never a font. */
  value: string;
  /** WHY - the relationship between the two. */
  why: string;
}

export interface ReferencePresentation {
  /** J4's plain-language reading of the reference. */
  inWords: string;
  /** Everything the owner may choose. Derived from the gate, never re-filtered. */
  choices: ReferenceChoice[];
  /**
   * Seen, and honestly unchangeable.
   *
   * Shown so the owner knows J4 noticed, and structurally incapable of being
   * chosen: these are strings, not choices, and carry no index into anything.
   */
  seenButUnchangeable: string[];
  /** True when J4 read the reference and found nothing it can act on. */
  nothingActionable: boolean;
}

export function presentReading(reading: ReferenceReading): ReferencePresentation {
  const byId = new Map(reading.observations.map((o) => [o.id, o]));
  const actionable = actionableProposals(reading);

  return {
    inWords: reading.inWords,
    choices: actionable.map((proposal, index) => ({
      index,
      // Guaranteed present: actionableProposals only returns proposals whose
      // cited observation exists AND matches their dimension.
      saw: byId.get(proposal.becauseOf)?.what ?? "",
      label: REFINABLE_DIMENSIONS[proposal.dimension].label,
      value: proposal.value,
      why: proposal.soThat,
    })),
    seenButUnchangeable: reading.observations.filter((o) => o.bearsOn === null).map((o) => o.what),
    nothingActionable: actionable.length === 0,
  };
}

/**
 * The refinements the owner actually chose.
 *
 * Reads actionableProposals back by index, so what a tick produces is the same
 * object the execution path will eventually receive. An index the owner could
 * not have been shown resolves to nothing rather than to a neighbour: a
 * selection that does not correspond to a choice is a bug, and quietly
 * applying the wrong refinement would be a worse one.
 *
 * Returns refinements; APPLIES nothing. Wiring this to refine_storefront is a
 * later, deliberate step.
 */
export function selectedRefinements(
  reading: ReferenceReading,
  selectedIndexes: number[],
): { dimension: string; value: string }[] {
  const actionable = actionableProposals(reading);
  const unique = [...new Set(selectedIndexes)].sort((a, b) => a - b);
  return unique
    .filter((i) => Number.isInteger(i) && i >= 0 && i < actionable.length)
    .map((i) => ({ dimension: actionable[i].dimension, value: actionable[i].value }));
}
