import type { RecordProvenance } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ENTITY_REGISTRY, type EntityType } from "./entities";
import { projectRecordRelationships } from "./relationships";
import type { SyncedRecord } from "@/lib/integrations/types";

// Phase 3 Milestone 2 — the write side of the Foundation's mapping
// contract. Validates every record a connector's sync() produces against
// the real Zod schema for its entityType (lib/businessModel/entities.ts)
// before it ever reaches BusinessRecord — this is what makes the Prisma
// model's own doc-comment ("data's shape is validated... at write time")
// actually true rather than aspirational. A malformed record is dropped
// and reported, never silently corrupts the table.
//
// The upsert keys on BusinessRecord's own
// @@unique([storeId, entityType, sourceProvider, externalId]) — a re-sync
// updates in place, never duplicates.
//
// ONE CHOKEPOINT, AND THAT IS WHY PROVENANCE LIVES HERE (2026-08-22).
// Every canonical record this platform has ever written goes through this
// function — twelve call sites, one door. Adding `origin` as a required
// argument therefore did in one place what would otherwise have been twelve
// separate opportunities to forget, and the type system now refuses a write
// that cannot say where its facts came from. Relationship projection rides the
// same door for the same reason: a graph maintained by each caller remembering
// to maintain it is a graph that is wrong by Thursday.

/**
 * Where the records in this batch came from. Required, never inferred.
 *
 * NOT DERIVED FROM sourceProvider, deliberately, though it easily could have
 * been. "quickbooks" plainly means CONNECTOR and a lookup table would have
 * saved twelve edits — but the same table would have to decide what
 * "genesis_chat" means, and it cannot: the owner's own typed sentence and a
 * model's reading of a voice memo arrive through that identical pipe. A mapping
 * that guesses right eleven times and silently wrong once is worse than no
 * mapping, because nothing downstream can tell which call it is looking at.
 */
export interface WriteOrigin {
  provenance: RecordProvenance;
  /** The concrete source: a connector name, or the Asset record id a document fact was read from. */
  provenanceDetail?: string | null;
  /**
   * When the SOURCE asserted it. Defaults to now, which is honest for a live
   * sync or a sentence typed a moment ago; a backfill or an extraction from a
   * dated document should pass the real date instead.
   */
  statedAt?: Date | null;
  /** The User who said it, where a person did. Null for connector and derived facts. */
  statedById?: string | null;
  /** Whether a model stood between the source and this record. */
  modelExtracted?: boolean | null;
}

export interface PersistSyncResult {
  written: number;
  errors: { externalId: string; entityType: string; error: string }[];
  // Phase 3 Milestone 3 (Business Intelligence Engine) — one pair per
  // successfully-written record, `previous: null` for a genuinely new
  // record. This is Change Detection's entire input; no separate history/
  // version table exists — the diff happens transiently here, at the one
  // moment both values are actually in hand, and anything worth
  // remembering durably becomes a BusinessEvent downstream.
  changes: {
    recordId: string;
    entityType: EntityType;
    previous: unknown | null;
    current: unknown;
  }[];
  /** How many typed relationships this batch projected. Reported, not silent. */
  relationshipsWritten: number;
}

export async function persistSyncedRecords(
  storeId: string,
  sourceProvider: string,
  records: SyncedRecord[],
  origin: WriteOrigin
): Promise<PersistSyncResult> {
  const errors: PersistSyncResult["errors"] = [];
  const changes: PersistSyncResult["changes"] = [];
  let written = 0;
  let relationshipsWritten = 0;

  const envelope = {
    provenance: origin.provenance,
    provenanceDetail: origin.provenanceDetail ?? null,
    statedAt: origin.statedAt ?? new Date(),
    statedById: origin.statedById ?? null,
    modelExtracted: origin.modelExtracted ?? null,
  };

  for (const record of records) {
    const registryEntry = ENTITY_REGISTRY[record.entityType];
    if (!registryEntry) {
      errors.push({
        externalId: record.externalId,
        entityType: record.entityType,
        error: `Unknown entity type "${record.entityType}"`,
      });
      continue;
    }

    const parsed = registryEntry.schema.safeParse(record.data);
    if (!parsed.success) {
      errors.push({
        externalId: record.externalId,
        entityType: record.entityType,
        error: parsed.error.message,
      });
      continue;
    }

    const existing = await prisma.businessRecord.findUnique({
      where: {
        storeId_entityType_sourceProvider_externalId: {
          storeId,
          entityType: record.entityType,
          sourceProvider,
          externalId: record.externalId,
        },
      },
      select: { id: true, data: true },
    });

    const row = await prisma.businessRecord.upsert({
      where: {
        storeId_entityType_sourceProvider_externalId: {
          storeId,
          entityType: record.entityType,
          sourceProvider,
          externalId: record.externalId,
        },
      },
      create: {
        storeId,
        entityType: record.entityType,
        sourceProvider,
        externalId: record.externalId,
        data: parsed.data,
        ...envelope,
      },
      update: {
        data: parsed.data,
        syncedAt: new Date(),
        // The newest write's origin is the current one — and it can only ever
        // overwrite its OWN, because sourceProvider is part of the unique key.
        // An owner's correction lands on a different row than the connector's
        // copy, so a re-sync cannot quietly restamp something a person said as
        // something QuickBooks published.
        ...envelope,
      },
    });
    written++;
    changes.push({
      recordId: row.id,
      entityType: record.entityType,
      previous: existing?.data ?? null,
      current: parsed.data,
    });

    const projected = await projectRecordRelationships({
      storeId,
      recordId: row.id,
      entityType: record.entityType,
      data: parsed.data,
      provenance: envelope.provenance,
      provenanceDetail: envelope.provenanceDetail,
      statedAt: envelope.statedAt,
      statedById: envelope.statedById,
    });
    relationshipsWritten += projected.length;
  }

  return { written, errors, changes, relationshipsWritten };
}
