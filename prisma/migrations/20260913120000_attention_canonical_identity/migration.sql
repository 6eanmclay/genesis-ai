-- CANONICAL IDENTITY FOR DEFERRED ATTENTION ITEMS (2026-09-13)
--
-- "Not now" is owner-level state, but it has been stored under the Business
-- arrival's own presentation id — "proposal:<id>", "observation:<dedupeKey>" —
-- so no other surface could ask whether an item was deferred. Proven on the
-- rendered page: dismiss an approval on the arrival and the Office still shows
-- it, live, in DECIDE.
--
-- This migration adds the canonical identity alongside the presentation id and
-- backfills it. It changes NO behaviour: nothing reads these columns yet.
--
-- ============ WHAT IT DELIBERATELY DOES NOT DO ==========================
--
--   * it does not drop or rewrite cardId — the existing reader and writer keep
--     working exactly as they do today;
--   * it does not delete a row it cannot map;
--   * it does not touch GenesisObservation, ApprovalRequest or Task at all;
--   * it does not add a unique constraint on the new pair. That is the key the
--     shared layer will want, but constraining before the production
--     population is known would let this migration FAIL rather than describe.

ALTER TABLE "DismissedAttentionCard" ADD COLUMN "source" TEXT;
ALTER TABLE "DismissedAttentionCard" ADD COLUMN "sourceId" TEXT;

CREATE INDEX "DismissedAttentionCard_storeId_source_sourceId_idx"
  ON "DismissedAttentionCard"("storeId", "source", "sourceId");

-- ============ THE BACKFILL ==============================================
--
-- NOTHING IS PARSED. Each statement builds the id the producer WOULD have
-- written for a real row — 'proposal:' || a."id" — and joins on equality. The
-- direction matters: a presentation id is never taken apart to guess at a
-- record; a record is asked what its presentation id would be, and the
-- database decides whether that is the row. A legacy id that matches no real
-- row simply does not match, and is left alone.
--
-- Each statement is guarded by "source" IS NULL, so re-running writes nothing
-- new: the backfill is idempotent by construction rather than by luck.
--
-- Fan-out is impossible. ApprovalRequest.id and Task.id are primary keys, and
-- GenesisObservation has @@unique([storeId, dedupeKey]) — so each statement
-- can match at most one row per store, and a cardId is a pure function of the
-- record, so two cardIds cannot describe one record.

UPDATE "DismissedAttentionCard" d
SET "source" = 'approval', "sourceId" = a."id"
FROM "ApprovalRequest" a
WHERE d."source" IS NULL
  AND a."storeId" = d."storeId"
  AND d."cardId" = 'proposal:' || a."id";

UPDATE "DismissedAttentionCard" d
SET "source" = 'task', "sourceId" = t."id"
FROM "Task" t
WHERE d."source" IS NULL
  AND t."storeId" = d."storeId"
  AND d."cardId" = 'task:' || t."id";

-- THE ONE THAT NEEDED THE DATABASE. An observation's presentation id carries
-- its dedupeKey, which is the detection identity and not the record's. The
-- real relationship — (storeId, dedupeKey) -> id — is what resolves it, and it
-- is a relationship the schema already guarantees is one-to-one.
UPDATE "DismissedAttentionCard" d
SET "source" = 'observation', "sourceId" = o."id"
FROM "GenesisObservation" o
WHERE d."source" IS NULL
  AND o."storeId" = d."storeId"
  AND d."cardId" = 'observation:' || o."dedupeKey";

-- WHAT IS LEFT UNMAPPED, on purpose and without apology:
--
--   issue:<id> and discovery:<id>   the arrival's own populations. They have
--                                   no canonical source in the three the
--                                   shared layer defines, so there is nothing
--                                   honest to write.
--   an observation, approval or task whose record is gone. The dismissal
--                                   outlives the thing it was about; there is
--                                   no id to point at, and inventing one is
--                                   exactly what this whole change is undoing.
--
-- Those rows keep "source" NULL and keep working through cardId, which is why
-- cardId is still here.
