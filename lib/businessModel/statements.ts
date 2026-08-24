import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import { ENTITY_REGISTRY, type EntityType } from "./entities";
import { persistSyncedRecords } from "./sync";
import { relate, isRelationshipKind, type RelationshipKind } from "./relationships";
import {
  isOwnerAuthoritative,
  markSuperseded,
  resolveSupersessionTarget,
} from "./factLifecycle";
import { internalContactId, internalItemId, internalTransactionId } from "./internalMapper";

// THE CONTROLLED PATH FOR SAYING SOMETHING NEW (2026-08-22, U3).
//
// Understanding is otherwise DERIVED and read-safe: getBusinessUnderstanding
// computes, queryRecords reads, and the twelve write sites are all internal
// pipelines with their own provenance. What did not exist was a way for a
// person to state a fact or draw a connection deliberately — and adding one is
// where a knowledge model usually stops being trustworthy.
//
// THE FAILURE THIS FILE EXISTS TO PREVENT. persistSyncedRecords takes
// provenance as an argument, which is right for a pipeline that knows what it
// is: the QuickBooks sync genuinely knows it is a connector. Handing that same
// argument to anything a browser can reach would let a caller stamp their own
// typed sentence as CONNECTOR — a claim that a connected system published it —
// and every downstream reader would believe it, because believing it is exactly
// what the column was built for. The whole value of provenance is destroyed by
// the first path that lets the client choose it.
//
// So nothing here accepts a provenance. It is DERIVED FROM THE ACTOR: a person
// stating something is OWNER, statedById is the authenticated user and not a
// parameter, and that is the only combination these functions can produce.
//
// AUTHORIZATION IS THE CALLER'S JOB, and deliberately so. Every function here
// takes a userId it treats as already authenticated — lib/permissions.ts's
// requireStorePermission is the chokepoint for that, and re-implementing it
// here would be a second answer to a question that already has one. What this
// file owns is the DATA invariants: the store actually contains the records
// being linked, the entity type is registered, the shape validates, the
// relationship kind is real.

export type StatementRefusal =
  | "unknown_entity_type"
  | "invalid_shape"
  | "unknown_kind"
  | "unknown_record"
  | "self_reference"
  | "not_stated"
  // A correction naming a record that is not a real record of that type in this
  // store. Refused rather than written as an unrelated new fact, which would
  // leave the owner believing they had corrected something they had not.
  | "unknown_target";

export type StatementOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; refusal: StatementRefusal; detail: string };

/**
 * Does this store actually contain the record this id names?
 *
 * NOT a simple BusinessRecord lookup, because half the records a real
 * relationship can point at do not have a row: the internal mapper computes
 * contacts, transactions and items live from the store's own Orders and
 * Products, with synthetic ids. Refusing those would make "this order was
 * placed by that customer" — the most ordinary relationship in the product —
 * unstateable.
 *
 * The tenant check is the point. Without it a caller could name any id at all
 * and get an edge pointing out of their own store at a record they cannot read,
 * which is not a data leak but is a graph nobody can reason about honestly.
 */
export async function recordExistsInStore(
  storeId: string,
  recordId: string
): Promise<boolean> {
  if (recordId.startsWith("internal:")) {
    // Resolved against the SOURCE rows, scoped by store, rather than trusted
    // for looking well-formed. An id is a string anybody can type.
    const [, kind, ...rest] = recordId.split(":");
    const tail = rest.join(":");
    if (!tail) return false;

    if (kind === "item") {
      return (await prisma.product.count({ where: { id: tail, storeId } })) > 0;
    }
    if (kind === "transaction") {
      return (await prisma.order.count({ where: { id: tail, storeId } })) > 0;
    }
    if (kind === "contact") {
      // A derived contact exists exactly as long as an order from that address
      // does — the same condition deriveContactsFromOrders itself computes.
      return (await prisma.order.count({ where: { storeId, buyerEmail: tail } })) > 0;
    }
    return false;
  }

  return (await prisma.businessRecord.count({ where: { id: recordId, storeId } })) > 0;
}

/** The canonical internal ids, re-exported so a caller does not rebuild them by hand. */
export const internalIds = {
  contact: internalContactId,
  item: internalItemId,
  transaction: internalTransactionId,
};

/**
 * Record a fact a PERSON stated.
 *
 * Provenance is not a parameter and cannot be one. Everything written here is
 * OWNER, authored by the passed user, because that is what actually happened —
 * a person said it. A caller wanting to record a connector's fact has
 * persistSyncedRecords, which is not reachable from a browser.
 *
 * `modelExtracted` IS a parameter, and it is the one thing the server legitimately
 * knows that the actor does not: whether this sentence came through an extractor
 * or was typed into a field. It is a server-side fact about the code path, never
 * client input.
 */
export async function stateFact(params: {
  storeId: string;
  /** Already authenticated and already authorized by the caller. */
  userId: string;
  entityType: string;
  data: unknown;
  /** True when an extractor produced this from something the person said or wrote. */
  modelExtracted: boolean;
  /** Where they said it: "chat", "meeting", a form name. Never parsed. */
  context?: string;
  /**
   * A stable identity for a fact the business has exactly ONE of.
   *
   * Omitted, every call writes a new record — right for goals and challenges,
   * which accumulate. Supplied, the existing unique constraint on
   * (storeId, entityType, sourceProvider, externalId) makes the write an
   * update, so restating what the business sells corrects the answer instead of
   * leaving two of them for a reader to choose between.
   */
  externalId?: string;
  /**
   * When the owner said it, if that is not now — a form filled in before the
   * store existed being the case this was added for. Never a guess.
   */
  statedAt?: Date;
  /**
   * The record this statement CORRECTS, when it corrects one (D5).
   *
   * Supplied explicitly or not at all. Nothing here infers a target from text
   * similarity or from ordering — see resolveSupersessionTarget, which is the
   * only thing allowed to decide, and which refuses an id it cannot confirm
   * belongs to this store and this type.
   *
   * Singleton types (offering, intent) do not need it: they have exactly one
   * current fact, so the target is unambiguous by construction.
   */
  supersedesRecordId?: string | null;
}): Promise<StatementOutcome<{ recordId: string; supersededRecordId?: string }>> {
  const registryEntry = ENTITY_REGISTRY[params.entityType as EntityType];
  if (!registryEntry) {
    return { ok: false, refusal: "unknown_entity_type", detail: params.entityType };
  }

  const parsed = registryEntry.schema.safeParse(params.data);
  if (!parsed.success) {
    return { ok: false, refusal: "invalid_shape", detail: parsed.error.message };
  }

  // RESOLVED BEFORE THE WRITE, and that ordering is load-bearing.
  //
  // A singleton's target is "the fact that is current". Resolving after writing
  // made the NEW record the newest current one, so it resolved to itself and the
  // guard below silently declined to supersede anything — two current offerings,
  // no link, and the correction looking like it had worked. Found by the suite
  // rather than by reading it back.
  //
  // A named target does not care about ordering; a singleton does, so both are
  // resolved here where the answer is still "what did the business say before
  // this sentence".
  const correction = isOwnerAuthoritative(params.entityType)
    ? await resolveSupersessionTarget({
        storeId: params.storeId,
        entityType: params.entityType,
        supersedesRecordId: params.supersedesRecordId,
      })
    : { targetId: null as string | null, refusal: undefined };

  // REFUSED BEFORE ANYTHING IS WRITTEN. A correction naming a record that cannot
  // be confirmed must not leave a new fact behind — the owner would believe they
  // had corrected something they had not.
  if (correction.refusal === "unknown_target") {
    return { ok: false, refusal: "unknown_target", detail: params.supersedesRecordId ?? "" };
  }

  const result = await persistSyncedRecords(
    params.storeId,
    "genesis_stated",
    [{ entityType: params.entityType as EntityType, externalId: params.externalId ?? randomUUID(), data: parsed.data }],
    {
      // NOT from the caller. This is the invariant the whole file exists for.
      provenance: "OWNER",
      provenanceDetail: params.context ?? "stated",
      statedById: params.userId,
      modelExtracted: params.modelExtracted,
      ...(params.statedAt ? { statedAt: params.statedAt } : {}),
    }
  );

  if (result.errors.length > 0 || !result.changes[0]) {
    return { ok: false, refusal: "invalid_shape", detail: result.errors[0]?.error ?? "not written" };
  }

  const recordId = result.changes[0].recordId;

  // THE LINK, WRITTEN ON THE OLD RECORD (D5).
  //
  // The new statement is already the authoritative current fact — it was written
  // above, and nothing had to be deleted for that to be true. What remains is to
  // say WHICH earlier statement it replaces, explicitly, rather than leaving a
  // later reader to infer it from timestamps.
  //
  // NOTHING IS OVERWRITTEN. The prior fact keeps its text, its provenance, its
  // author and the date it was said. It stops being current; it does not stop
  // existing. That is the whole of D2, and it is what makes a mistaken
  // correction recoverable rather than destructive.
  if (correction.targetId && correction.targetId !== recordId) {
    await markSuperseded({
      storeId: params.storeId,
      supersededRecordId: correction.targetId,
      replacedByRecordId: recordId,
    });
    return { ok: true, value: { recordId, supersededRecordId: correction.targetId } };
  }

  return { ok: true, value: { recordId } };
}

/**
 * Draw a connection a PERSON stated.
 *
 * Left with a null projectedFrom, which is what makes it durable: a connector
 * re-syncing either endpoint reconciles only the edges its own projection owns
 * and never touches this one. An owner who says "the supplier delay is what is
 * holding up the new line" should not have that erased by a routine sync an
 * hour later.
 */
export async function stateRelationship(params: {
  storeId: string;
  userId: string;
  fromId: string;
  fromType: EntityType;
  toId: string;
  toType: EntityType;
  kind: string;
  context?: string;
}): Promise<StatementOutcome<null>> {
  if (!isRelationshipKind(params.kind)) {
    return { ok: false, refusal: "unknown_kind", detail: params.kind };
  }
  if (params.fromId === params.toId) {
    return { ok: false, refusal: "self_reference", detail: params.fromId };
  }

  // BOTH ends, both scoped to this store. Checking one would let a caller
  // anchor on something real and point it anywhere.
  const [fromExists, toExists] = await Promise.all([
    recordExistsInStore(params.storeId, params.fromId),
    recordExistsInStore(params.storeId, params.toId),
  ]);
  if (!fromExists) return { ok: false, refusal: "unknown_record", detail: params.fromId };
  if (!toExists) return { ok: false, refusal: "unknown_record", detail: params.toId };

  await relate({
    storeId: params.storeId,
    fromId: params.fromId,
    fromType: params.fromType,
    toId: params.toId,
    toType: params.toType,
    kind: params.kind,
    provenance: "OWNER",
    provenanceDetail: params.context ?? "stated",
    statedAt: new Date(),
    statedById: params.userId,
    // Deliberately absent: nothing maintains this but the person who said it.
    projectedFrom: null,
  });

  return { ok: true, value: null };
}

/**
 * Take back a connection somebody stated.
 *
 * ONLY a stated one. A projected edge is a restatement of what a record's own
 * data says, so deleting it here would leave the graph disagreeing with the
 * record until the next sync silently put it back — a correction that appears
 * to work and then quietly undoes itself is worse than one that refuses. The
 * honest fix for a wrong projected edge is to correct the record it came from,
 * and `not_stated` says exactly that rather than pretending.
 */
export async function retractRelationship(params: {
  storeId: string;
  fromId: string;
  toId: string;
  kind: string;
}): Promise<StatementOutcome<null>> {
  if (!isRelationshipKind(params.kind)) {
    return { ok: false, refusal: "unknown_kind", detail: params.kind };
  }

  const existing = await prisma.recordRelationship.findFirst({
    // storeId in the WHERE clause, not checked after the read.
    where: { storeId: params.storeId, fromId: params.fromId, toId: params.toId, kind: params.kind },
    select: { id: true, projectedFrom: true },
  });
  if (!existing) {
    return { ok: false, refusal: "unknown_record", detail: `${params.fromId} -> ${params.toId}` };
  }
  if (existing.projectedFrom) {
    return {
      ok: false,
      refusal: "not_stated",
      detail: `maintained by record ${existing.projectedFrom}`,
    };
  }

  await prisma.recordRelationship.deleteMany({
    where: { storeId: params.storeId, id: existing.id },
  });
  return { ok: true, value: null };
}

/** What to tell a person when one of these refuses. Never the refusal code. */
export const REFUSAL_MESSAGE: Record<StatementRefusal, string> = {
  unknown_entity_type: "I don't have a place to keep that kind of thing yet.",
  invalid_shape: "I couldn't make sense of that — some of it was missing or the wrong shape.",
  unknown_kind: "I don't have a way to describe that kind of connection.",
  unknown_record: "I couldn't find one of those in this business.",
  self_reference: "Something can't be connected to itself.",
  unknown_target: "I couldn't find the thing you're correcting — tell me which one you mean.",
  not_stated:
    "That connection comes from the record itself, so changing the record is what changes it.",
};

export type { RelationshipKind };
