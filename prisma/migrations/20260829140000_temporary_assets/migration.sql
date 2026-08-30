-- Creation artefacts that do not belong to anybody yet.
--
-- STORAGE.md section 5: a failed Create must discard its print files and
-- mockups, and a temporary asset must be "recoverable by a sweep even when the
-- code that created it never got to run its own cleanup".
--
-- The row is written BEFORE the blob. A row with no blob is harmless; a blob
-- with no row is the leak this exists to close.
--
-- Deliberately narrow: only artefacts of one creation attempt are ever
-- represented here, so the deletion path cannot see a customer's own upload.
CREATE TABLE "TemporaryAsset" (
  "id"          TEXT NOT NULL,
  "storeId"     TEXT NOT NULL,
  "url"         TEXT,
  "pathname"    TEXT NOT NULL,
  "kind"        TEXT NOT NULL,
  "sizeInBytes" INTEGER,
  "promotedAt"  TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "TemporaryAsset_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TemporaryAsset_url_key" ON "TemporaryAsset"("url");
CREATE UNIQUE INDEX "TemporaryAsset_pathname_key" ON "TemporaryAsset"("pathname");
-- The sweep's own query: unpromoted, old enough.
CREATE INDEX "TemporaryAsset_promotedAt_createdAt_idx" ON "TemporaryAsset"("promotedAt", "createdAt");
CREATE INDEX "TemporaryAsset_storeId_promotedAt_idx" ON "TemporaryAsset"("storeId", "promotedAt");

ALTER TABLE "TemporaryAsset" ADD CONSTRAINT "TemporaryAsset_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
