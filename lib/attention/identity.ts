/**
 * ONE NAME FOR ONE THING THE OWNER MIGHT HAVE TO DEAL WITH.
 *
 * ============ WHY THIS EXISTS (2026-09-13) =============================
 *
 * The Business arrival and the Office both answer "what needs me" from the
 * same three tables, and an audit of one seeded business on both rendered
 * surfaces showed they do not agree on what to CALL a row:
 *
 *   ApprovalRequest      arrival "proposal:<id>"            Office "<id>"
 *   Task                 arrival "task:<id>"                Office "task:<id>"
 *   GenesisObservation   arrival "observation:<dedupeKey>"  Office "<id>"
 *
 * Tasks already agree. Approvals differ only by a prefix. Observations — the
 * largest population — share no key at all: one surface names the row, the
 * other names the dedup condition that produced it.
 *
 * That is why dismissing an approval on the arrival leaves it live in the
 * Office: the state it wrote is keyed to a PRESENTATION identity that the
 * Office has no way to ask about. Sean: "the shared attention state cannot
 * work correctly while DismissedAttentionCard.cardId is keyed to a
 * Business-arrival presentation ID."
 *
 * ============ WHAT A CANONICAL IDENTITY IS HERE =======================
 *
 * The underlying row's own primary key, and nothing else. Never a card id,
 * never a dedupeKey, never a string another layer assembled for display.
 *
 * Sean's constraint, verbatim: "Do not solve this with string parsing, prefix
 * stripping, headline matching, or ID inference." So this module never parses
 * anything. A ref is built FROM a row by a function that takes the row's id,
 * and the pair travels as two fields rather than one string — there is no
 * encoded form to take apart, which is the only way to be sure nobody does.
 *
 * ============ WHY AN OBSERVATION IS ITS ROW ID, NOT ITS dedupeKey =====
 *
 * This was the one real question, and it is settled by how observations are
 * written rather than by preference. `upsertObservation` upserts on
 * (storeId, dedupeKey) and its own comment states the intent:
 *
 *   "Reactivates a previously RESOLVED row if the same condition recurs, so
 *    identity survives a resolve/reappear cycle instead of spawning a second
 *    row for the same real thing."
 *
 * A row is never deleted and recreated for the same condition — resolving
 * sets status and re-detection reactivates the same row. So the primary key
 * and the dedup condition have the SAME lifetime, and the primary key is the
 * better canonical identity of the two:
 *
 *   - it is what the Office already renders, so one surface needs no change;
 *   - it is a real key other tables can reference;
 *   - a dedupeKey is namespaced by the sweep that produced it (see
 *     resolveMissingObservations' required prefix), which makes it a fact
 *     about PROVENANCE, not about the thing observed. Two sweeps could in
 *     principle describe one condition; the row is still the record.
 *
 * The dedupeKey keeps its job — deciding whether a newly detected condition
 * is one we already have. It simply stops being how other surfaces name it.
 */

/** The three real populations an owner's attention is drawn from. */
export type AttentionSource = "approval" | "task" | "observation";

/**
 * One underlying item, named the way every surface must name it.
 *
 * TWO FIELDS, NOT ONE STRING, deliberately. A single "approval:abc123" key
 * would have to be parsed to be used, and parsing is exactly the mechanism
 * that let two surfaces invent different spellings of the same row. Storage
 * keys on the pair; code passes the pair; nothing takes a key apart.
 */
export interface AttentionRef {
  source: AttentionSource;
  /**
   * The underlying row's primary key.
   *
   * ApprovalRequest.id, Task.id, GenesisObservation.id. Never a card id, a
   * dedupeKey, a work id, or anything a renderer built.
   */
  id: string;
}

/**
 * A pending approval, by its own id.
 *
 * The arrival stores `proposal:<id>` and the Office renders `<id>`; both are
 * this row. The word "proposal" is an internal type name that has never been
 * rendered to an owner — the product shows "Decide" and "Decisions" — so
 * `approval` is named for the table rather than for either surface's habit.
 */
export function approvalRef(approvalRequestId: string): AttentionRef {
  return { source: "approval", id: approvalRequestId };
}

/**
 * An open task, by its own id.
 *
 * Already what both surfaces use. Task keeps its own target/action semantics
 * where they live — this says which task, not what can be done about it.
 */
export function taskRef(taskId: string): AttentionRef {
  return { source: "task", id: taskId };
}

/**
 * Something J4 noticed, by the row's own id — see the note above on why this
 * is the row and not the dedupeKey.
 */
export function observationRef(observationId: string): AttentionRef {
  return { source: "observation", id: observationId };
}

/** Whether two refs name the same underlying item. */
export function sameItem(a: AttentionRef, b: AttentionRef): boolean {
  return a.source === b.source && a.id === b.id;
}

/**
 * Every source, so a suite can assert the set rather than restate it.
 *
 * A fourth population (a Commerce surface's own, say) must be added here and
 * given a ref builder, which is the point: the next surface consumes this
 * layer instead of inventing a fourth way to name the same rows.
 */
export const ATTENTION_SOURCES: readonly AttentionSource[] = ["approval", "task", "observation"] as const;
