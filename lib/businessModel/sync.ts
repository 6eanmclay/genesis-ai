import { prisma } from "@/lib/prisma";
import { ENTITY_REGISTRY } from "./entities";
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
}

export async function persistSyncedRecords(
  storeId: string,
  sourceProvider: string,
  records: SyncedRecord[]
): Promise<PersistSyncResult> {
  const errors: PersistSyncResult["errors"] = [];
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

    await prisma.businessRecord.upsert({
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
  }

  return { written, errors };
}
