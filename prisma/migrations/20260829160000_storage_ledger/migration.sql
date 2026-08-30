-- Slice 2 step 1 — the ledger tables. Additive; nothing writes to them yet.
--
-- StorageObject is one row per blob, written BEFORE the blob. A row with no
-- blob is harmless; a blob with no row is invisible, and invisible is the leak.
--
-- StorageEvent is append-only and answers one question: what happened to bytes
-- that are no longer here. StorageObject deliberately has no deletedAt.
CREATE TABLE "StorageObject" (
  "id"            TEXT NOT NULL,
  "pathname"      TEXT NOT NULL,
  "url"           TEXT,
  -- Nullable on purpose: "I do not know who owns this" must be representable.
  "storeId"       TEXT,
  "attribution"   TEXT NOT NULL DEFAULT 'unattributed',
  "lifecycle"     TEXT NOT NULL,
  "prefix"        TEXT NOT NULL,
  "source"        TEXT NOT NULL,
  "batchId"       TEXT,
  "declaredBytes" INTEGER,
  "sizeInBytes"   INTEGER,
  "contentType"   TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "uploadedAt"    TIMESTAMP(3),
  "touchedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt"    TIMESTAMP(3),

  CONSTRAINT "StorageObject_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StorageObject_pathname_key" ON "StorageObject"("pathname");
CREATE UNIQUE INDEX "StorageObject_url_key" ON "StorageObject"("url");
CREATE INDEX "StorageObject_storeId_uploadedAt_idx" ON "StorageObject"("storeId", "uploadedAt");
CREATE INDEX "StorageObject_storeId_uploadedAt_touchedAt_idx" ON "StorageObject"("storeId", "uploadedAt", "touchedAt");
CREATE INDEX "StorageObject_batchId_idx" ON "StorageObject"("batchId");
CREATE INDEX "StorageObject_lifecycle_createdAt_idx" ON "StorageObject"("lifecycle", "createdAt");
CREATE INDEX "StorageObject_lastSeenAt_idx" ON "StorageObject"("lastSeenAt");

-- SetNull, not Cascade: deleting a store must not erase the record of bytes
-- that may still be sitting in the provider. They become unattributed, which
-- is a real state with a name.
ALTER TABLE "StorageObject" ADD CONSTRAINT "StorageObject_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "StorageEvent" (
  "id"          TEXT NOT NULL,
  -- Not a foreign key: the object it describes is usually gone.
  "pathname"    TEXT NOT NULL,
  "storeId"     TEXT,
  "kind"        TEXT NOT NULL,
  "sizeInBytes" INTEGER,
  "lifecycle"   TEXT,
  "actor"       TEXT NOT NULL,
  "reason"      TEXT NOT NULL,
  "occurredAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "StorageEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "StorageEvent_storeId_occurredAt_idx" ON "StorageEvent"("storeId", "occurredAt");
CREATE INDEX "StorageEvent_pathname_idx" ON "StorageEvent"("pathname");
CREATE INDEX "StorageEvent_kind_occurredAt_idx" ON "StorageEvent"("kind", "occurredAt");
