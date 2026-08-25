import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ENTITY_REGISTRY, type EntityType, type CanonicalRecord } from "./entities";

// THE BUSINESS FACT LIFECYCLE.
//
// BUSINESS_FACT_LIFECYCLE_CONTRACT.md, closed 2026-08-24. The problem it exists
// for, in one sentence: J4 could hold a fact about a business — including what it
// sells — that the person running it could neither see nor correct.
//
// THE SIX DECISIONS, as they land in code:
//
//   D1  Supersession, ADDITIVE to `status`. A goal marked `achieved` was true and
//       is now done; a goal that was superseded is no longer what we believe.
//       Different facts, so different fields. `status` is untouched here.
//   D2  History is preserved, and the CURRENT fact is readable without any
//       consumer walking the chain — see currentFacts() below, which is one
//       indexed query with a JSON filter and no application-side loop.
//   D3  Six owner-authoritative types, and only those.
//   D4  No surface. These are the backend semantics a future one will use.
//   D5  A contradiction is resolved EXPLICITLY, never inferred. Nothing here
//       matches on text similarity or guesses from timestamps: either the caller
//       names the record being corrected, or the type has exactly one current
//       fact and the target is unambiguous by construction.
//   D6  Beliefs are not touched. No confidence model reaches a Fact.

/**
 * The types for which the OWNER is the authoritative source (D3).
 *
 * Derived from a property rather than kept as a list: only the owner knows what
 * they want, who works for them, where they operate, what they sell, and what
 * they are trying to become. Everything else in ENTITY_REGISTRY belongs to a
 * connector, to arithmetic over rows this platform owns, to a document the owner
 * supplied, or to J4 itself.
 *
 * A QuickBooks transaction is deliberately absent. "Correcting" one here would
 * write a fact the next sync silently overwrites — worse than refusing, because
 * it would look like it worked.
 */
export const OWNER_AUTHORITATIVE_TYPES = [
  "goal",
  "challenge",
  "employee",
  "location",
  "offering",
  "intent",
  // D1-A (2026-08-24). Claims about the business that J4 reasons from, promoted
  // out of the brandIdentity blob where they had no author and no correction
  // path. The owner is the authoritative source for who their business is for.
  "targetAudience",
  "brandPersonality",
  "brandVoice",
  "sellingProposition",
] as const;

export type OwnerAuthoritativeType = (typeof OWNER_AUTHORITATIVE_TYPES)[number];

export function isOwnerAuthoritative(type: string): type is OwnerAuthoritativeType {
  return (OWNER_AUTHORITATIVE_TYPES as readonly string[]).includes(type);
}

/**
 * The types a business has exactly ONE current instance of.
 *
 * This is what makes D5's "explicitly, not inferred" reachable for them without
 * the caller naming a record: there is only one thing a restatement could be
 * correcting, so the target is unambiguous by construction rather than by
 * guesswork. A business has many goals; it has one answer to "what do you sell".
 */
export const SINGLETON_FACT_TYPES = [
  "offering",
  "intent",
  // A business has one answer to each of these, so a restatement corrects the
  // one that exists rather than adding a second — the target is unambiguous by
  // construction and needs no explicit id.
  "targetAudience",
  "brandPersonality",
  "brandVoice",
  "sellingProposition",
] as const;

export type SingletonFactType = (typeof SINGLETON_FACT_TYPES)[number];

export function isSingletonFact(type: string): boolean {
  return (SINGLETON_FACT_TYPES as readonly string[]).includes(type);
}

/** The supersession link, carried in the record's own payload. */
export const SUPERSEDED_BY = "supersededByRecordId";

/**
 * Every current fact of a type — one query, no traversal (D2).
 *
 * THE CONSTRAINT THIS EXISTS TO MEET. The asset pattern this generalises reads
 * every asset row for the store and loops in application code until it finds one
 * that is not superseded. That is correct and it is still traversal, invisible at
 * ten call sites and not invisible as a general mechanism. D2 forbids it.
 *
 * So "not superseded" is a filter the database applies. Postgres can query into
 * jsonb directly, and a record whose payload has no such key at all — every row
 * written before this shipped — is matched by the null branch rather than being
 * excluded. Existing facts stay current, which is the correct reading of a
 * history nobody has corrected.
 */
export async function currentFacts<T extends EntityType>(
  storeId: string,
  entityType: T
): Promise<CanonicalRecord<T>[]> {
  const rows = await prisma.businessRecord.findMany({
    where: {
      storeId,
      entityType,
      // Not superseded: the key is absent (written before this existed) or null.
      OR: [
        { data: { path: [SUPERSEDED_BY], equals: Prisma.DbNull } },
        { NOT: { data: { path: [SUPERSEDED_BY], not: Prisma.DbNull } } },
      ],
    },
    orderBy: { syncedAt: "desc" },
  });
  return rows.map(toCanonical) as CanonicalRecord<T>[];
}

/**
 * The whole chain for a type, superseded records included, newest first.
 *
 * The other half of D2: "they used to sell candles and now sell rings" is real
 * business knowledge, and it is only knowledge if something can read it.
 */
export async function factHistory<T extends EntityType>(
  storeId: string,
  entityType: T
): Promise<CanonicalRecord<T>[]> {
  const rows = await prisma.businessRecord.findMany({
    where: { storeId, entityType },
    orderBy: { syncedAt: "desc" },
  });
  return rows.map(toCanonical) as CanonicalRecord<T>[];
}

/** Whether one record has been corrected by a later one. */
export function isSuperseded(record: { data: unknown }): boolean {
  const link = (record.data as Record<string, unknown> | null)?.[SUPERSEDED_BY];
  return typeof link === "string" && link.length > 0;
}

/**
 * Which record a new owner statement corrects, decided explicitly (D5).
 *
 * NOTHING HERE INFERS. Three ways a target is established, and no fourth:
 *
 *   1. the caller names it — `supersedesRecordId`, checked to be a real record
 *      of the right type in the right store before it is trusted;
 *   2. the type is a singleton, so the one current record IS the target;
 *   3. otherwise there is no target, and the statement is a NEW fact.
 *
 * No text matching, no "looks similar", no newest-wins. A restatement the owner
 * did not tie to anything, about a type they may have many of, is a new goal —
 * not a silent correction of whichever one happened to be closest.
 */
export async function resolveSupersessionTarget(params: {
  storeId: string;
  entityType: OwnerAuthoritativeType;
  supersedesRecordId?: string | null;
}): Promise<{ targetId: string | null; refusal?: "unknown_target" }> {
  const { storeId, entityType, supersedesRecordId } = params;

  if (supersedesRecordId) {
    // NEVER TRUSTED AS GIVEN. A record id arriving from a tool call is model
    // output; confirming it is a real record of this type in this store is the
    // difference between a correction and a cross-tenant write.
    const target = await prisma.businessRecord.findFirst({
      where: { id: supersedesRecordId, storeId, entityType },
      select: { id: true },
    });
    return target ? { targetId: target.id } : { targetId: null, refusal: "unknown_target" };
  }

  if (isSingletonFact(entityType)) {
    const current = await currentFacts(storeId, entityType);
    return { targetId: current[0]?.id ?? null };
  }

  return { targetId: null };
}

/**
 * Link a corrected record to the one that replaced it.
 *
 * The link is written on the OLD record, which is what lets currentFacts ask one
 * question of the database instead of walking anything. The new record carries
 * no pointer at all, so it needs no update when it is itself corrected later.
 */
export async function markSuperseded(params: {
  storeId: string;
  supersededRecordId: string;
  replacedByRecordId: string;
}): Promise<void> {
  const row = await prisma.businessRecord.findFirst({
    where: { id: params.supersededRecordId, storeId: params.storeId },
    select: { id: true, data: true },
  });
  if (!row) return;
  await prisma.businessRecord.update({
    where: { id: row.id, storeId: params.storeId },
    data: {
      data: {
        ...(row.data as Record<string, unknown>),
        [SUPERSEDED_BY]: params.replacedByRecordId,
      },
      // syncedAt is NOT touched. This row did not gain new information; it
      // stopped being current, and moving its timestamp would misreport when the
      // business last said something about it.
    },
  });
}

function toCanonical(row: {
  id: string;
  entityType: string;
  sourceProvider: string;
  data: unknown;
  syncedAt: Date;
  provenance: unknown;
  provenanceDetail: string | null;
  statedAt: Date | null;
  statedById: string | null;
  modelExtracted: boolean | null;
}): CanonicalRecord {
  return {
    id: row.id,
    entityType: row.entityType as EntityType,
    sourceProvider: row.sourceProvider,
    data: row.data as never,
    syncedAt: row.syncedAt,
    provenance: row.provenance as never,
    provenanceDetail: row.provenanceDetail,
    statedAt: row.statedAt,
    statedById: row.statedById,
    modelExtracted: row.modelExtracted,
  };
}

/** Guards the registry cross-check in the suite. */
export function ownerAuthoritativeTypesAreRegistered(): boolean {
  return OWNER_AUTHORITATIVE_TYPES.every((t) => Object.hasOwn(ENTITY_REGISTRY, t));
}
