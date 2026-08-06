import { uploadAssetFile } from "./uploadAssetFile";
import { persistSyncedRecords } from "@/lib/businessModel/sync";
import { prisma } from "@/lib/prisma";
import type { Asset } from "@/lib/businessModel/entities";

// Business Assets M1 — the write side. Reuses persistSyncedRecords (the
// same validated-upsert path every real connector's sync() already goes
// through) rather than writing BusinessRecord directly, so a genesis_upload
// row gets the identical schema validation and @@unique upsert-in-place
// behavior any other source provider gets — an upload is just another
// source of real business data, not a special case.
const SOURCE_PROVIDER = "genesis_upload";

export async function ingestBusinessAsset(storeId: string, file: File) {
  const uploaded = await uploadAssetFile(file);

  const data: Asset = {
    fileType: uploaded.fileType,
    category: "unclassified",
    storageUrl: uploaded.url,
    originalFilename: uploaded.originalFilename,
    summary: null,
    extractionConfidence: null,
    relatedRecordId: null,
    relatedEntityType: null,
  };

  const result = await persistSyncedRecords(storeId, SOURCE_PROVIDER, [
    { entityType: "asset", externalId: uploaded.url, data },
  ]);

  if (result.errors.length > 0) {
    throw new Error(result.errors[0].error);
  }

  const record = await prisma.businessRecord.findUniqueOrThrow({
    where: {
      storeId_entityType_sourceProvider_externalId: {
        storeId,
        entityType: "asset",
        sourceProvider: SOURCE_PROVIDER,
        externalId: uploaded.url,
      },
    },
  });

  return record;
}
