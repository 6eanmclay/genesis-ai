-- Provenance and typed relationships for canonical business records.
--
-- Two gaps, one migration, because they are the same gap seen twice: J4 held
-- facts it could not source and connections it could not name.
--
-- PURELY ADDITIVE. Every column added here is nullable and nothing is dropped,
-- renamed, or rewritten -- which matters more than usual, because the honest
-- value for an existing row IS null. A BusinessRecord written before today has
-- a sourceProvider and nothing else; inferring "quickbooks means CONNECTOR,
-- therefore backfill CONNECTOR" would be defensible for that one case and
-- catastrophic as a habit, since the same reasoning applied to "genesis_chat"
-- cannot tell an owner's own sentence from a model's reading of it. The column
-- exists to stop the system claiming more than it knows. Backfilling it by
-- guessing would be the first thing it does wrong.
--
-- modelExtracted is nullable for the same reason and NOT defaulted to false:
-- false is a claim ("nothing interpreted this"), and a historical row is not
-- entitled to make it.

CREATE TYPE "RecordProvenance" AS ENUM (
  'CONNECTOR',
  'OWNER',
  'DOCUMENT',
  'DERIVED',
  'INFERENCE',
  'GENERATED'
);

ALTER TABLE "BusinessRecord"
  ADD COLUMN "provenance"       "RecordProvenance",
  ADD COLUMN "provenanceDetail" TEXT,
  ADD COLUMN "statedAt"         TIMESTAMP(3),
  ADD COLUMN "statedById"       TEXT,
  ADD COLUMN "modelExtracted"   BOOLEAN;

-- The typed relationship table.
--
-- No foreign key on fromId/toId, deliberately. Half the records these can
-- legitimately point at are computed live by lib/businessModel/internalMapper.ts
-- from the store's own Order/Product rows and have no BusinessRecord row to
-- constrain against. A FK would make the most common real relationship in the
-- product -- this order was placed by that customer -- unrepresentable.
--
-- storeId is on the row rather than reached through a join because every read
-- is tenant-scoped and the index has to be able to enforce that cheaply.
CREATE TABLE "RecordRelationship" (
  "id"               TEXT NOT NULL,
  "storeId"          TEXT NOT NULL,
  "fromId"           TEXT NOT NULL,
  "fromType"         TEXT NOT NULL,
  "toId"             TEXT NOT NULL,
  "toType"           TEXT NOT NULL,
  "kind"             TEXT NOT NULL,
  "provenance"       "RecordProvenance",
  "provenanceDetail" TEXT,
  "statedAt"         TIMESTAMP(3),
  "statedById"       TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "RecordRelationship_pkey" PRIMARY KEY ("id")
);

-- One link of one kind between two records: re-projecting the same reference
-- is an upsert, not a duplicate.
CREATE UNIQUE INDEX "RecordRelationship_storeId_fromId_kind_toId_key"
  ON "RecordRelationship"("storeId", "fromId", "kind", "toId");

-- BOTH DIRECTIONS. The reverse index is the entire reason this table exists:
-- "what references this record?" was previously answered by loading every
-- record of every entity type and scanning its keys in memory.
CREATE INDEX "RecordRelationship_storeId_fromId_idx"
  ON "RecordRelationship"("storeId", "fromId");
CREATE INDEX "RecordRelationship_storeId_toId_idx"
  ON "RecordRelationship"("storeId", "toId");

ALTER TABLE "RecordRelationship"
  ADD CONSTRAINT "RecordRelationship_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
