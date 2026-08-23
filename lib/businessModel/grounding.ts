import type { RecordProvenance } from "@prisma/client";
import {
  PROVENANCE_GROUNDING,
  describeStatedAge,
  isDefeasibleClaim,
  isFirstPartyEvidence,
  type ProvenanceEnvelope,
} from "./provenance";

// TELLING A PROMPT WHAT IT IS LOOKING AT (2026-08-22, U6).
//
// THE GAP THIS CLOSES. Provenance reached BusinessRecord in the morning and
// stopped at the serialiser: cognitiveLayer handed Reason
// `goals.map((g) => ({ id: g.id, ...g.data }))`, and `...g.data` is the fact
// with its origin stripped off. So the model saw a goal the owner stated
// yesterday and a goal a model inferred from a photograph in March as the same
// two lines of JSON, and reasoned about them identically — which is what the
// whole column exists to stop.
//
// That is not an oversight peculiar to this file; the codebase already names the
// rule. J4_REASON_VALIDATION.md: "a new Understand capability does NOT reach
// Reason just because Understand computed it — it takes a bounded extension".
// This is that extension.
//
// WHAT THIS IS NOT: a weighting. Sean's U6 approval was explicit — reasoning
// becomes provenance-AWARE, told what it is looking at and expected to reason
// accordingly, rather than handed a number somebody invented. There is no score
// here, because no honest ranking exists: the owner is the only authority on
// what the business is trying to do, and QuickBooks is a better authority than
// the owner on what was invoiced. Ordering those would be a fiction.
//
// AND NOT A LECTURE, either. groundingRules returns sentences only for the kinds
// of source ACTUALLY PRESENT in what is being sent. A prompt carrying five
// paragraphs about document extraction, for a business that has uploaded
// nothing, spends context teaching the model to be careful about facts that do
// not exist — and every unnecessary rule dilutes the ones that matter.

/**
 * One fact's origin, compact enough to sit on every item in a prompt payload.
 *
 * `null` throughout for a record nobody sourced — every row written before
 * 2026-08-22. Deliberately not "unknown": a literal string on hundreds of
 * historical facts would read to the model as a positive claim that their origin
 * was investigated and could not be found, which is a different and stronger
 * statement than nobody having recorded it.
 */
export interface FactSource {
  /** CONNECTOR | OWNER | DOCUMENT | DERIVED | INFERENCE | GENERATED. */
  from: RecordProvenance | null;
  /** The concrete source within that kind — a connector's name, a document id. */
  via: string | null;
  /** How long ago the source asserted it, in words. Null when unstated. */
  stated: string | null;
  /**
   * True only when a model stood between the source and the record AND the
   * source was somebody other than J4.
   *
   * Omitted on J4's own output, where it is noise: of course a model was
   * involved in something J4 concluded or produced.
   */
  interpreted?: true;
  /**
   * True when this is a claim that could turn out to be untrue, as opposed to
   * evidence or an artifact.
   *
   * The single most useful bit for a reasoning model, and the reason it is
   * stated rather than left to be inferred from `from`: it is the difference
   * between a sentence that needs qualifying and one that does not.
   */
  couldBeWrong?: true;
}

/**
 * Describe where one canonical record came from.
 *
 * Returns null when nothing was recorded, so a serialiser can omit the key
 * entirely rather than decorate every historical fact with empty structure.
 */
export function sourceOf(
  envelope: ProvenanceEnvelope,
  now: Date = new Date()
): FactSource | null {
  if (!envelope.provenance) return null;

  const source: FactSource = {
    from: envelope.provenance,
    via: envelope.provenanceDetail,
    stated: describeStatedAge(envelope.statedAt, now),
  };
  if (envelope.modelExtracted === true && isFirstPartyEvidence(envelope.provenance)) {
    source.interpreted = true;
  }
  if (isDefeasibleClaim(envelope.provenance)) {
    source.couldBeWrong = true;
  }
  return source;
}

/**
 * Attach a source to a serialised fact, without inventing structure where there
 * is none.
 *
 * The spread is the point: a caller writes `withSource({ id, ...data }, record)`
 * and the shape it was already sending is unchanged when nothing is known.
 */
export function withSource<T extends object>(
  serialised: T,
  envelope: ProvenanceEnvelope,
  now: Date = new Date()
): T & { source?: FactSource } {
  const source = sourceOf(envelope, now);
  return source ? { ...serialised, source } : serialised;
}

/**
 * The rules a prompt needs, given what it is actually carrying.
 *
 * Only the kinds present. A business with no connectors and no uploads gets two
 * sentences, not six — and the two it gets are the ones that apply to it.
 *
 * The order is fixed rather than following the order records happened to arrive
 * in, so the same business produces the same prompt twice. A block that reorders
 * itself between runs defeats prompt caching for no benefit and makes two
 * otherwise-identical passes impossible to compare.
 */
export function groundingRules(
  envelopes: ProvenanceEnvelope[],
  order: readonly RecordProvenance[] = [
    "OWNER",
    "CONNECTOR",
    "DOCUMENT",
    "DERIVED",
    "INFERENCE",
    "GENERATED",
  ]
): string[] {
  const present = new Set(
    envelopes.map((e) => e.provenance).filter((p): p is RecordProvenance => p !== null)
  );
  return order.filter((p) => present.has(p)).map((p) => `${p}: ${PROVENANCE_GROUNDING[p]}`);
}

/**
 * How much of what is being sent has no recorded origin at all.
 *
 * Reported rather than hidden, and reported as a COUNT rather than by
 * decorating each fact. Every record written before 2026-08-22 is in this
 * number, so on a real store it will be large for a while and then shrink on its
 * own as records are re-synced and restated. A reader that saw only sourced
 * facts would conclude J4 knows less than it does; one told "and 40 more facts
 * whose origin predates this" knows exactly where it stands.
 */
export function unsourcedCount(envelopes: ProvenanceEnvelope[]): number {
  return envelopes.filter((e) => e.provenance === null).length;
}
