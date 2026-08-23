import type { RecordProvenance } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { EntityType } from "./entities";

// HOW FACTS RELATE (2026-08-22, J4's Understanding milestone, U2).
//
// THE GAP THIS CLOSES. Relationships existed by CONVENTION: any field in a
// record's `data` named xxxId or xxxIds held another record's id, and
// findRelated (lib/businessModel/reasoning.ts) answered "what references this?"
// by loading every record of every entity type into memory and scanning its
// keys. That is genuinely clever, it works, and it has two costs that only
// became load-bearing once J4 started reasoning out loud.
//
// FIRST: it cannot say WHAT a connection is. A challenge listing a goal's id in
// relatedGoalIds might block it, fund it, or merely mention it — the field name
// is the only clue and it says "related". So the single most useful sentence J4
// could offer an owner, "this is the thing standing between you and that", was
// the one thing the model could not represent. It could point; it could not
// explain.
//
// SECOND: it is O(everything). Every reverse lookup fetched every record of all
// fifteen registered types, including the ones the internal mapper computes live
// from every Order and Product the store has ever had.
//
// THIS TABLE IS A PROJECTION, NOT A SECOND OPINION. The id fields inside `data`
// remain the source of truth for the records that carry them; PROJECTIONS below
// says exactly which field becomes which relationship, and persistSyncedRecords
// re-projects on every write. A row here that disagrees with the record it came
// from is a bug in the projection. There is no second place to edit.
//
// WHAT THE CONVENTION GOT WRONG, now that it is written down explicitly: it
// matched too much. `shipment.orderId` holds an Order.id, `asset.aiUsageEventId`
// holds an AiUsageEvent.id, and `campaign.groupId` holds a provider's own group
// id — none of them a BusinessRecord, all of them ending in "Id" and all of them
// scanned by findRelated on every traversal. Cuid collisions make that harmless
// in practice rather than by design. The projection map below is an explicit
// list precisely so that "ends in Id" stops being the same statement as "points
// at a canonical record".

/**
 * The closed vocabulary of relationship kinds.
 *
 * DERIVED FROM WHAT THE DATA ACTUALLY HOLDS, not invented for completeness.
 * Every kind here except one is backed by a real reference field already in the
 * entity registry (see PROJECTIONS); `supplies` is the exception and is called
 * out where it is defined.
 *
 * Each carries phrasing for BOTH directions, because a relationship read from
 * the far end is a different sentence: an order involves a product, and a
 * product is involved in an order. A single label would force every reverse
 * lookup to render backwards.
 */
export const RELATIONSHIP_KINDS = {
  belongs_to: {
    label: "Belongs to",
    forward: "belongs to",
    reverse: "has",
    /** An order belongs to the customer who placed it; an invoice to its contact. */
    description: "One record is the property or responsibility of another.",
  },
  involves: {
    label: "Involves",
    forward: "involves",
    reverse: "is involved in",
    /** An order involves the products on it; an appointment involves its attendees. */
    description: "One record includes another as a participant or line item.",
  },
  located_at: {
    label: "Located at",
    forward: "is at",
    reverse: "is where",
    description: "One record happens at, or is based at, a location.",
  },
  blocks: {
    label: "Blocks",
    forward: "is standing in the way of",
    reverse: "is held up by",
    /**
     * THE KIND THIS MILESTONE EXISTS FOR. goal <-> challenge was already
     * representable as a shared id and was already meaningless: two records
     * that know about each other and cannot say which one is the problem.
     */
    description: "A challenge is preventing progress on a goal.",
  },
  supersedes: {
    label: "Supersedes",
    forward: "replaced",
    reverse: "was replaced by",
    description: "One record took over from an earlier one, which is kept.",
  },
  derived_from: {
    label: "Derived from",
    forward: "was made from",
    reverse: "was used to make",
    description: "One record was produced out of another — a design from its assets, a commitment from the document stating it.",
  },
  supplies: {
    label: "Supplies",
    forward: "supplies",
    reverse: "is supplied by",
    /**
     * NAMED AS A REQUIREMENT, NOT YET PROJECTED FROM ANYTHING (2026-08-22).
     *
     * A supplier is a Contact carrying the "vendor" role — that is how
     * getBusinessProfile already derives `suppliers`, with no separate storage.
     * What does not exist anywhere is a field tying that vendor to the items
     * they supply: no schema carries it, no connector populates it, and
     * inventing one would be creating the entity relationship rather than
     * recording it.
     *
     * So this kind is writable through relate() the moment anything real has
     * something to say, and PROJECTIONS deliberately produces none. Honest
     * empty, same as Item.quantityAvailable's own documented gap: a real code
     * path with nothing to feed it yet.
     */
    description: "A vendor provides a product the business sells.",
  },
  about: {
    label: "About",
    forward: "is about",
    reverse: "is the subject of",
    description: "One record concerns another without a more specific connection.",
  },
} as const;

export type RelationshipKind = keyof typeof RELATIONSHIP_KINDS;

export const RELATIONSHIP_KIND_KEYS = Object.keys(RELATIONSHIP_KINDS) as RelationshipKind[];

export function isRelationshipKind(value: string): value is RelationshipKind {
  // Object.hasOwn, not `value in`, for the reason ARCHITECTURE.md's sibling
  // rule spells out: `"constructor" in RELATIONSHIP_KINDS` is true, and a
  // prototype key reaching a write is how a registry lookup stops being closed.
  return Object.hasOwn(RELATIONSHIP_KINDS, value);
}

/**
 * Which reference field on which entity type becomes which relationship.
 *
 * The explicit replacement for "any key ending in Id". Reading down this list is
 * the only way to know what J4 can actually connect, which is the point — the
 * convention's coverage was knowable only by grepping Zod schemas.
 *
 * `reversed: true` means the edge is stored pointing the OTHER way. A goal
 * listing its challenges and a challenge listing its goals are the same edge
 * seen from two ends; storing both would double every blocked goal and make
 * "how many things are blocking me" a question with two answers. Canonical
 * direction wins, and the reverse index makes reading it from either end free.
 */
interface Projection {
  field: string;
  kind: RelationshipKind;
  toType: EntityType;
  reversed?: boolean;
}

export const PROJECTIONS: Partial<Record<EntityType, Projection[]>> = {
  transaction: [
    // An order belongs to the customer who placed it, and involves what was on
    // it. Sean's "customer -> order" and "product -> order" are exactly these
    // two, already representable, and never before named.
    { field: "contactId", kind: "belongs_to", toType: "contact" },
    { field: "itemIds", kind: "involves", toType: "item" },
  ],
  appointment: [
    { field: "contactIds", kind: "involves", toType: "contact" },
    { field: "locationId", kind: "located_at", toType: "location" },
  ],
  document: [{ field: "contactId", kind: "belongs_to", toType: "contact" }],
  employee: [{ field: "locationId", kind: "located_at", toType: "location" }],
  // Stored challenge -> goal in both cases: the challenge is the thing doing
  // the blocking, so that is the direction the sentence reads in.
  challenge: [{ field: "relatedGoalIds", kind: "blocks", toType: "goal" }],
  goal: [{ field: "relatedChallengeIds", kind: "blocks", toType: "challenge", reversed: true }],
  asset: [
    // supersededByAssetId is the same edge from the other end, so it is not
    // projected — see `reversed` above.
    { field: "supersedesAssetId", kind: "supersedes", toType: "asset" },
    { field: "relatedRecordId", kind: "about", toType: "contact" },
  ],
  design: [{ field: "assetIds", kind: "derived_from", toType: "asset" }],
  commitment: [{ field: "sourceAssetRecordId", kind: "derived_from", toType: "asset" }],
  // DELIBERATELY ABSENT: item, campaign, socialAccount, shipment, location,
  // contact. Their id-shaped fields point at Orders, AiUsageEvents and provider
  // group ids — real references to things that are not canonical records. The
  // convention scanned them anyway.
};

export interface RelationshipInput {
  storeId: string;
  fromId: string;
  fromType: EntityType;
  toId: string;
  toType: EntityType;
  kind: RelationshipKind;
  provenance: RecordProvenance;
  provenanceDetail?: string | null;
  statedAt?: Date | null;
  statedById?: string | null;
}

export interface RecordRelation {
  id: string;
  fromId: string;
  fromType: string;
  toId: string;
  toType: string;
  kind: string;
  provenance: RecordProvenance | null;
  provenanceDetail: string | null;
  statedAt: Date | null;
  statedById: string | null;
  /** Which end of the edge the record asked about sits on. */
  direction: "outgoing" | "incoming";
}

/**
 * Record one relationship, with its provenance.
 *
 * Provenance is REQUIRED here and nullable in the column, and that asymmetry is
 * deliberate: the column has to hold null for rows that predate it, and no new
 * write is allowed to add one. A link with no stated origin is a claim nobody
 * made.
 *
 * Upserts on the unique key, so re-projecting the same reference updates rather
 * than duplicating — a connector re-syncing an unchanged invoice must not grow
 * the graph.
 */
export async function relate(input: RelationshipInput): Promise<void> {
  if (!isRelationshipKind(input.kind)) {
    throw new Error(`Unknown relationship kind "${input.kind}"`);
  }
  // A record related to itself is never information, and the convention could
  // produce one from a self-referencing id field.
  if (input.fromId === input.toId) return;

  const envelope = {
    provenance: input.provenance,
    provenanceDetail: input.provenanceDetail ?? null,
    statedAt: input.statedAt ?? null,
    statedById: input.statedById ?? null,
  };

  await prisma.recordRelationship.upsert({
    where: {
      storeId_fromId_kind_toId: {
        storeId: input.storeId,
        fromId: input.fromId,
        kind: input.kind,
        toId: input.toId,
      },
    },
    create: {
      storeId: input.storeId,
      fromId: input.fromId,
      fromType: input.fromType,
      toId: input.toId,
      toType: input.toType,
      kind: input.kind,
      ...envelope,
    },
    update: {
      fromType: input.fromType,
      toType: input.toType,
      ...envelope,
    },
  });
}

/**
 * The row as a reader sees it.
 *
 * storeId and createdAt are dropped rather than spread through: the caller
 * already knows which store it asked about, and when the EDGE row was written is
 * a different question from when the relationship was stated — carrying both
 * invites a reader to mistake one for the other, which is the same confusion
 * statedAt exists on BusinessRecord to prevent.
 */
function toRelation(
  row: {
    id: string; fromId: string; fromType: string; toId: string; toType: string;
    kind: string; provenance: RecordProvenance | null; provenanceDetail: string | null;
    statedAt: Date | null; statedById: string | null;
  },
  direction: "outgoing" | "incoming"
): RecordRelation {
  return {
    id: row.id,
    fromId: row.fromId,
    fromType: row.fromType,
    toId: row.toId,
    toType: row.toType,
    kind: row.kind,
    provenance: row.provenance,
    provenanceDetail: row.provenanceDetail,
    statedAt: row.statedAt,
    statedById: row.statedById,
    direction,
  };
}

/**
 * Every relationship touching one record, from either end.
 *
 * TWO INDEXED QUERIES. This is the whole reason the table exists: the same
 * question previously fetched every record of every entity type and scanned its
 * keys in memory.
 *
 * storeId is in both WHERE clauses rather than checked afterwards — scoping a
 * read by filtering its results is how one tenant's rows get counted before they
 * get dropped.
 */
export async function relationsOf(
  storeId: string,
  recordId: string
): Promise<RecordRelation[]> {
  const [outgoing, incoming] = await Promise.all([
    prisma.recordRelationship.findMany({ where: { storeId, fromId: recordId } }),
    prisma.recordRelationship.findMany({ where: { storeId, toId: recordId } }),
  ]);

  return [
    ...outgoing.map((r) => toRelation(r, "outgoing")),
    ...incoming.map((r) => toRelation(r, "incoming")),
  ];
}

/**
 * Every record of a given kind of relationship, store-wide.
 *
 * What makes "what is blocking my goals?" a single query instead of a traversal.
 */
export async function relationsByKind(
  storeId: string,
  kind: RelationshipKind
): Promise<RecordRelation[]> {
  const rows = await prisma.recordRelationship.findMany({ where: { storeId, kind } });
  return rows.map((r) => toRelation(r, "outgoing"));
}

/**
 * Turn one record's reference fields into relationships.
 *
 * Called by persistSyncedRecords on every write, so the graph is maintained by
 * the same chokepoint that validates the record itself rather than by each of
 * the twelve call sites remembering to.
 *
 * Inherits the record's own provenance, which is the correct answer and not a
 * convenient one: the reference came in the same payload as the record, from the
 * same source, at the same moment. A connector that says "this invoice is for
 * that contact" is asserting the link exactly as much as it is asserting the
 * invoice.
 *
 * Returns what it wrote rather than nothing, so a caller can report it and a
 * suite can assert on it without re-reading the table.
 */
export async function projectRecordRelationships(params: {
  storeId: string;
  recordId: string;
  entityType: EntityType;
  data: unknown;
  provenance: RecordProvenance;
  provenanceDetail?: string | null;
  statedAt?: Date | null;
  statedById?: string | null;
}): Promise<{ kind: RelationshipKind; toId: string }[]> {
  const projections = PROJECTIONS[params.entityType];
  if (!projections) return [];

  const data = params.data as Record<string, unknown> | null;
  if (!data || typeof data !== "object") return [];

  const written: { kind: RelationshipKind; toId: string }[] = [];

  for (const projection of projections) {
    const raw = data[projection.field];

    // An id field that is null, absent, or an empty array is the ordinary
    // state — most records reference nothing — and produces no edge rather
    // than an edge to nothing.
    const targets: string[] = Array.isArray(raw)
      ? raw.filter((v): v is string => typeof v === "string" && v.length > 0)
      : typeof raw === "string" && raw.length > 0
        ? [raw]
        : [];

    for (const targetId of targets) {
      const edge = projection.reversed
        ? {
            fromId: targetId,
            fromType: projection.toType,
            toId: params.recordId,
            toType: params.entityType,
          }
        : {
            fromId: params.recordId,
            fromType: params.entityType,
            toId: targetId,
            toType: projection.toType,
          };

      await relate({
        storeId: params.storeId,
        kind: projection.kind,
        provenance: params.provenance,
        provenanceDetail: params.provenanceDetail ?? null,
        statedAt: params.statedAt ?? null,
        statedById: params.statedById ?? null,
        ...edge,
      });
      written.push({ kind: projection.kind, toId: edge.toId });
    }
  }

  return written;
}

/**
 * How to read one relationship aloud, from the perspective of the record asked
 * about.
 *
 * The direction handling is the substance: "your cash flow problem is standing
 * in the way of opening a second location" and "opening a second location is
 * held up by your cash flow problem" are the same row, and which one is the
 * right sentence depends entirely on which record the owner is looking at.
 */
export function describeRelation(relation: RecordRelation): string {
  const kind = isRelationshipKind(relation.kind) ? RELATIONSHIP_KINDS[relation.kind] : null;
  // A kind that is not in the registry can only come from a row written before
  // it was, or by hand. Rendering the raw key at an owner is the failure
  // ARCHITECTURE.md's own label invariant exists to stop, so fall back to
  // something that is at least a sentence.
  if (!kind) return relation.direction === "outgoing" ? "relates to" : "is related to";
  return relation.direction === "outgoing" ? kind.forward : kind.reverse;
}
