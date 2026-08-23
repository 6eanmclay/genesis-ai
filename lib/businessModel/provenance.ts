import type { RecordProvenance } from "@prisma/client";

// WHERE A FACT CAME FROM (2026-08-22, J4's Understanding milestone, U1).
//
// THE GAP THIS CLOSES. Per-field provenance already existed in this codebase
// and already worked — on exactly one table. SupplierEconomics knows who stated
// a minimum order, when, and by what route, because those figures are about
// somebody's money and a wrong one has a price. Everywhere else, a fact sitting
// in BusinessRecord.data had no origin at all: the goal J4 reasons from, the
// audience it describes, the challenge it plans around could each have come
// from a connector, a document, a sentence the owner typed, or a model's own
// conclusion, and nothing downstream could tell which.
//
// WHY THAT IS NOT AN ACADEMIC PROBLEM. J4 acts. A recommendation grounded in
// what QuickBooks published and one grounded in what a model inferred from a
// photograph deserve different confidence and different language — and until
// this file existed they were the same shape, so they got the same voice.
// "Do not pretend inference is equivalent to first-party evidence" (Sean,
// 2026-08-22) is the whole design brief, and it is not satisfiable by a system
// that cannot tell them apart in the first place.
//
// WHAT THIS FILE IS NOT. It is not a scoring model. There is no number here
// that ranks a document above a conversation, because no such ranking is true:
// the owner is the only authority on what the business is trying to do, and
// QuickBooks is a better authority than the owner on what was invoiced. What
// this file provides is the DISTINCTION and the words for it. Judging is the
// reader's job, done with the facts in hand rather than in place of them.

/**
 * The runtime vocabulary, mirroring the RecordProvenance enum in schema.prisma.
 *
 * A hand-maintained mirror of another registry, which ARCHITECTURE.md's standing
 * invariant says must carry a runtime cross-check — scripts/verify-provenance.ts
 * asserts this list and the Prisma enum agree in both directions. The literal
 * exists because TypeScript's enum type is erased and this list has to be
 * iterated, rendered, and validated against at runtime.
 */
export const RECORD_PROVENANCE = [
  "CONNECTOR",
  "OWNER",
  "DOCUMENT",
  "DERIVED",
  "INFERENCE",
  "GENERATED",
] as const satisfies readonly RecordProvenance[];

/**
 * What to call each one in front of an owner.
 *
 * Never the enum name. "INFERENCE" is machine vocabulary and reads as authority
 * precisely where the least is warranted.
 */
export const PROVENANCE_LABEL: Record<RecordProvenance, string> = {
  CONNECTOR: "From a connected system",
  OWNER: "You told me",
  DOCUMENT: "Read from a document you shared",
  DERIVED: "Worked out from your own orders",
  INFERENCE: "Something I concluded",
  GENERATED: "I made this",
};

/**
 * The sentence a reasoning prompt is given about a fact of this kind.
 *
 * Written as guidance to a reader rather than as a weight, per U6: the model is
 * told what it is looking at and expected to reason accordingly, instead of
 * being handed a number somebody invented. Each says what the source is good
 * for AND what it is not — a grade that only ever flatters its source teaches
 * nothing.
 */
export const PROVENANCE_GROUNDING: Record<RecordProvenance, string> = {
  CONNECTOR:
    "A connected system published this. Treat it as accurate about what that system records, and no more current than its last sync.",
  OWNER:
    "The owner stated this themselves. On intent, priorities and constraints they are the only authority; on figures, they may be recalling rather than checking.",
  DOCUMENT:
    "This was read out of a document the owner provided. The document is real evidence; the reading of it is not certain. Quote it rather than paraphrasing when it matters.",
  DERIVED:
    "This was computed from the store's own orders and products. It is as reliable as those records and needs no hedging.",
  INFERENCE:
    "You concluded this yourself. Nothing outside this system asserted it, so it may be wrong. Say so when you use it, and never present it as something the owner or a connected system told you.",
  GENERATED:
    "You produced this yourself — an image, a design, a draft. It exists and is real; it simply came from you rather than from the owner or a connected system. Do not attribute it to anyone, and do not hedge it either.",
};

/**
 * Whether anything outside J4 actually asserted this.
 *
 * The single most consequential distinction in the file. INFERENCE and GENERATED
 * are the two kinds with no external referent — one is a claim J4 made up, the
 * other a thing J4 made. Everything else, including a document a model had to
 * read, began with something real outside this system saying something.
 */
export function isFirstPartyEvidence(provenance: RecordProvenance | null): boolean {
  if (!provenance) return false;
  return provenance !== "INFERENCE" && provenance !== "GENERATED";
}

/**
 * Whether a person authored this.
 *
 * Distinct from first-party: a connector is first-party evidence with no author,
 * and asking "who said this?" of a QuickBooks invoice has no answer. Used to
 * decide whether statedById is meaningful, never to rank.
 */
export function hasHumanAuthor(provenance: RecordProvenance | null): boolean {
  return provenance === "OWNER";
}

/**
 * Whether this is a claim that could turn out to be untrue, as opposed to an
 * artifact that simply exists.
 *
 * The reason GENERATED is not INFERENCE. Both came from J4 and neither is
 * evidence, but only one of them can be WRONG — a design J4 composed is a file,
 * and hedging it ("I think this might be your logo") would be as dishonest as
 * stating an inference flatly. Reasoning uses this to decide whether language
 * needs qualifying, which is a different question from whether to trust it.
 */
export function isDefeasibleClaim(provenance: RecordProvenance | null): boolean {
  return provenance === "INFERENCE";
}

/**
 * The envelope every canonical record now carries.
 *
 * All five nullable, together, because a record written before 2026-08-22 has
 * none of them and a partial envelope would be worse than an absent one: a
 * statedAt with no provenance says "somebody said this at some point" and names
 * nothing.
 */
export interface ProvenanceEnvelope {
  provenance: RecordProvenance | null;
  provenanceDetail: string | null;
  statedAt: Date | null;
  statedById: string | null;
  /**
   * Whether a model stood between the source and the record.
   *
   * NULLABLE and not defaulted, which is the point: false is itself a claim —
   * "nothing interpreted this" — and a historical row is not entitled to make
   * it. Null means nobody recorded whether a model was involved.
   */
  modelExtracted: boolean | null;
}

/**
 * How old a stated fact is, in words, with no verdict attached.
 *
 * DELIBERATELY NO isStale. The connector case already has a real staleness
 * threshold because there is a real sync cadence to compare against
 * (lib/businessModel/profile.ts). Nothing comparable is true of the others: a
 * goal the owner stated in March is not stale, it is eight months old and may
 * be exactly as true as the day they said it — or entirely abandoned, and no
 * threshold in this file can tell the difference. Inventing one would be
 * precisely the "invented default that makes the system look smarter than it
 * is" this codebase refuses elsewhere.
 *
 * So: report the age, let the reader weigh it, and let the owner correct it.
 */
export function describeStatedAge(
  statedAt: Date | null,
  now: Date = new Date()
): string | null {
  if (!statedAt) return null;

  const ageMs = now.getTime() - statedAt.getTime();

  // A statedAt in the future is not an age, it is a bad write. Saying nothing
  // is honest; saying "in 3 days" invites a reader to reason about it.
  if (ageMs < 0) return null;

  const days = Math.floor(ageMs / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;

  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

/**
 * One line describing a fact's origin, for a prompt or an owner-facing panel.
 *
 * Returns null rather than a placeholder when provenance is unknown. A caller
 * that renders "Source: unknown" next to every pre-existing record has turned a
 * quiet gap into visual noise on data that is probably fine; a caller that needs
 * to say something can check for null and decide. Two silences are not the same
 * silence, and this one means "nobody recorded it", not "it came from nowhere".
 */
export function describeProvenance(
  envelope: ProvenanceEnvelope,
  now: Date = new Date()
): string | null {
  if (!envelope.provenance) return null;

  const parts: string[] = [PROVENANCE_LABEL[envelope.provenance]];

  if (envelope.provenanceDetail) parts.push(`(${envelope.provenanceDetail})`);

  const age = describeStatedAge(envelope.statedAt, now);
  if (age) parts.push(`— ${age}`);

  // Only worth saying where it changes how much the wording can be trusted.
  // On a DERIVED or CONNECTOR fact it is noise; on an OWNER fact it is the
  // difference between the owner's sentence and a model's summary of it.
  if (
    envelope.modelExtracted === true &&
    envelope.provenance !== "INFERENCE" &&
    envelope.provenance !== "GENERATED"
  ) {
    parts.push("(interpreted by J4)");
  }

  return parts.join(" ");
}
