import { REFINABLE_DIMENSIONS, type RefinableDimensionKey } from "@/lib/storefront/dimensions";

/**
 * WHAT J4 SAW IN A REFERENCE, AND WHAT J4 IS PROPOSING BECAUSE OF IT.
 *
 * ============ TWO DIFFERENT CLAIMS, NEVER ONE (2026-09-10) ============
 *
 * Sean: "The analysis should distinguish between what J4 actually observed and
 * what it is proposing."
 *
 * They are different kinds of statement and carry different authority. "The
 * headings are very large relative to the body text" is a reading of an image
 * the owner can check for themselves. "So set your type scale to display" is a
 * recommendation about THEIR store, which may be wrong even when the
 * observation is right - their brand may want restraint where the reference
 * shouts. Collapsing the two produces the failure this codebase keeps finding:
 * a confident sentence that cannot be checked, because nobody can tell which
 * half was seen and which was decided.
 *
 * So an observation names what is in the picture. A proposal names a dimension
 * and a value, and CITES the observation it came from. An owner reading
 * "because the headings dominate the page → type scale: display" can disagree
 * with either half independently, which is the whole point of showing them.
 *
 * ============ ONE VOCABULARY, AND IT IS NOT A NEW ONE =================
 *
 * Sean: "Do not invent a second design vocabulary. Reuse the existing
 * REFINABLE_DIMENSIONS."
 *
 * Every proposal is a `{ dimension, value }` from REFINABLE_DIMENSIONS - the
 * same closed pair `refine_storefront` already validates at its schema
 * boundary, and the same shape `applyRefinementsToTheme` already applies. This
 * module produces nothing an approved refinement could not already carry, so
 * there is no second execution path to build and none to keep in step.
 *
 * ============ PRINCIPLES OUT, NEVER ASSETS ============================
 *
 * J4_DESIGN_INSPIRATION.md's guardrail, and the reason it is a data shape
 * rather than an instruction: "The schema itself should have no field capable
 * of carrying a literal asset forward."
 *
 * There is no field here for a hex value, a font file, a logo, an image URL or
 * a line of the reference's copy - because `value` may only be one of the
 * enumerated values of its dimension, and those are words like "spacious" and
 * "split". A model that tried to smuggle #0A0A0A through this type could not:
 * it is not a member of any dimension's values. That is enforced by
 * isUsableProposal below and, independently, by the action's own schema.
 */

/** Something J4 read off the picture. A claim about the REFERENCE. */
export interface DesignObservation {
  /** A short id so a proposal can cite it. */
  id: string;
  /**
   * Plain language, and about the image only.
   *
   * "The headings are much larger than the body text" - not "your headings
   * should be larger", which is a proposal wearing an observation's clothes.
   */
  what: string;
  /** Which dimension it bears on, when it bears on one this system can act on. */
  bearsOn: RefinableDimensionKey | null;
}

/** Something J4 suggests doing to THIS store because of an observation. */
export interface DesignProposal {
  dimension: RefinableDimensionKey;
  /** Must be one of that dimension's own values. Never a colour, never a font. */
  value: string;
  /** The observation this came from. A proposal with no source is an opinion. */
  becauseOf: string;
  /** One owner-facing sentence for the approval card. */
  soThat: string;
}

export interface ReferenceReading {
  observations: DesignObservation[];
  proposals: DesignProposal[];
  /** J4's plain-language summary of the reference's design language. */
  inWords: string;
}

/** Is this a value the dimension actually offers? */
export function isUsableProposal(proposal: { dimension: string; value: string }): boolean {
  const dimension = REFINABLE_DIMENSIONS[proposal.dimension as RefinableDimensionKey];
  if (!dimension) return false;
  return (dimension.values as readonly string[]).includes(proposal.value);
}

/**
 * Every proposal that cannot be acted on, and why.
 *
 * Reported rather than silently dropped. A proposal naming a dimension that
 * does not exist, or a value that dimension does not offer, is the model
 * having invented vocabulary - which happened for real on 2026-09-05, when
 * eight refine_storefront executions failed on invented values and J4 told
 * Sean the storefront had been given "a more characterful headline font".
 * Dropping them quietly would reproduce exactly that: a confident report about
 * changes that never happened.
 */
export function unusableProposals(reading: ReferenceReading): string[] {
  return reading.proposals
    .filter((p) => !isUsableProposal(p))
    .map((p) => {
      const dimension = REFINABLE_DIMENSIONS[p.dimension];
      return dimension
        ? `${p.dimension} has no value "${p.value}" (offers: ${dimension.values.join(", ")})`
        : `there is no dimension called "${p.dimension}"`;
    });
}

/**
 * Proposals whose cited observation does not exist.
 *
 * The citation is the owner's ability to disagree with half of a suggestion.
 * An id pointing at nothing removes that without looking like it has.
 */
export function uncitedProposals(reading: ReferenceReading): string[] {
  const seen = new Set(reading.observations.map((o) => o.id));
  return reading.proposals.filter((p) => !seen.has(p.becauseOf)).map((p) => p.dimension);
}

/**
 * The refinement changes an approved reading would apply.
 *
 * Exactly the `{ dimension, value }` shape refine_storefront's own schema
 * accepts - so an approved reading travels the ordinary execution path and
 * nothing here needs permission to write anything.
 *
 * Only usable proposals survive. This function cannot be the place an invented
 * value reaches the store.
 */
export function refinementsFrom(reading: ReferenceReading): { dimension: string; value: string }[] {
  return reading.proposals
    .filter(isUsableProposal)
    .map((p) => ({ dimension: p.dimension, value: p.value }));
}

/**
 * What the owner is shown before anything happens: saw -> recommends -> why.
 *
 * Sean: "The UI should make the chain understandable to the owner: what J4 saw
 * → what it recommends → what will change → approval → result." This is the
 * first three links, derived from the reading rather than written beside it,
 * so the sentence on screen cannot describe a change the execution would not
 * make.
 */
export interface ExplainedChange {
  saw: string;
  recommends: string;
  soThat: string;
}

export function explainReading(reading: ReferenceReading): ExplainedChange[] {
  const byId = new Map(reading.observations.map((o) => [o.id, o]));
  return reading.proposals.filter(isUsableProposal).map((p) => ({
    saw: byId.get(p.becauseOf)?.what ?? "(an observation that is no longer present)",
    recommends: `${REFINABLE_DIMENSIONS[p.dimension].label}: ${p.value}`,
    soThat: p.soThat,
  }));
}
