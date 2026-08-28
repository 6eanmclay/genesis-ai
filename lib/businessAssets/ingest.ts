import { finalizeUploadedAssetFile } from "./uploadAssetFile";
import { detectTransparencyAt } from "./transparency";
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

export async function ingestBusinessAsset(
  storeId: string,
  uploaded: { url: string; originalFilename: string; contentType: string }
) {
  const uploadedFile = finalizeUploadedAssetFile(uploaded);

  const data: Asset = {
    fileType: uploadedFile.fileType,
    category: "unclassified",
    storageUrl: uploadedFile.url,
    originalFilename: uploadedFile.originalFilename,
    summary: null,
    extractionConfidence: null,
    relatedRecordId: null,
    relatedEntityType: null,
    // Designation (2026-08-16). An upload arrives undesignated on purpose:
    // nobody has said what it is FOR yet, and guessing a role from a filename
    // would be exactly the fabrication this codebase avoids elsewhere.
    // Classification, or the owner, gives it one later via designateAsset —
    // see lib/businessModel/assets.ts. `origin` is knowable now, so it is set.
    role: null,
    origin: "uploaded",
    supersedesAssetId: null,
    supersededByAssetId: null,
    generationPrompt: null,
    aiUsageEventId: null,

    // ---- The Creation Station library (2026-08-28) ----
    //
    // An upload is IN the owner's creative workspace from the moment it
    // arrives — that is the point of uploading it. Removing it later is their
    // decision and sets this to a date; it never deletes the record.
    creationLibraryRemovedAt: null,

    // MEASURED, NOT ASSUMED. Read from the file's own alpha channel, because
    // "png" says nothing about whether anything in it is see-through. Only
    // images are inspected: a PDF has no alpha and asking costs a download.
    //
    // Null when it could not be read, which is a different answer from false
    // and is why the upload still succeeds either way — an asset that stored
    // fine must not be rejected because a follow-up read of it did not.
    hasTransparency:
      uploadedFile.fileType === "photo" ? await detectTransparencyAt(uploadedFile.url) : null,

    createdAt: new Date().toISOString(),
  };

  const result = await persistSyncedRecords(
    storeId,
    SOURCE_PROVIDER,
    [{ entityType: "asset", externalId: uploadedFile.url, data }],
    {
      // OWNER rather than DOCUMENT, and the difference is real: this record is
      // the fact that a file exists and the owner gave it to us, which they
      // asserted by uploading it. What the file SAYS is a separate record with
      // separate provenance (classify.ts), extracted by a model that can be
      // wrong about it. Collapsing the two would make a misread invoice look
      // like something the owner had told us.
      provenance: "OWNER",
      provenanceDetail: "upload",
      modelExtracted: false,
    }
  );

  if (result.errors.length > 0) {
    throw new Error(result.errors[0].error);
  }

  const record = await prisma.businessRecord.findUniqueOrThrow({
    where: {
      storeId_entityType_sourceProvider_externalId: {
        storeId,
        entityType: "asset",
        sourceProvider: SOURCE_PROVIDER,
        externalId: uploadedFile.url,
      },
    },
  });

  return record;
}
