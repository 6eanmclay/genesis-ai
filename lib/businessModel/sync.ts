import { prisma } from "@/lib/prisma";
import { ENTITY_REGISTRY, type EntityType } from "./entities";
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
}

export async function persistSyncedRecords(
  storeId: string,
  sourceProvider: string,
  records: SyncedRecord[]
): Promise<PersistSyncResult> {
  const errors: PersistSyncResult["errors"] = [];
  const changes: PersistSyncResult["changes"] = [];
  let written = 0;

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
      },
      update: {
        data: parsed.data,
        syncedAt: new Date(),
      },
    });
    written++;
    changes.push({
      recordId: row.id,
      entityType: record.entityType,
      previous: existing?.data ?? null,
      current: parsed.data,
    });
  }

  return { written, errors, changes };
}
