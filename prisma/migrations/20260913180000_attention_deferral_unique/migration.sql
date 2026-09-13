-- ONE LIVE DEFERRAL PER UNDERLYING ITEM, PER BUSINESS (2026-09-13)
--
-- The evidence commit (75ef90b) found zero duplicate canonical keys and showed
-- that creating one is structurally impossible while a card id stays a pure
-- function of its record. This turns that observation into an invariant the
-- database holds.
--
-- ============ IT REFUSES RATHER THAN RECONCILES ========================
--
-- Sean: "do not assume the fixture/history proves the live production
-- population is clean... duplicate exists -> migration refuses to establish
-- the constraint -> clear diagnostic identifying the conflicting canonical
-- key. No destructive reconciliation."
--
-- So the preflight below looks first and raises. It does not pick a winner,
-- does not delete a row, does not merge timestamps, and does not widen the
-- constraint to make itself pass. If production holds something this file did
-- not expect, the migration stops and says exactly which key is wrong, and a
-- person decides what it means.
--
-- Prisma Migrate runs a migration file inside a transaction on Postgres, so a
-- RAISE here rolls the whole file back: no index is left half-created and the
-- schema is exactly as it was.

DO $preflight$
DECLARE
  conflict RECORD;
  total INTEGER;
BEGIN
  SELECT count(*) INTO total
  FROM (
    SELECT 1
    FROM "DismissedAttentionCard"
    WHERE "source" IS NOT NULL AND "sourceId" IS NOT NULL
    GROUP BY "storeId", "source", "sourceId"
    HAVING count(*) > 1
  ) AS duplicates;

  IF total > 0 THEN
    -- NAME ONE, AND SAY HOW MANY. A count alone sends somebody hunting; the
    -- first offending key plus the total is enough to start from.
    SELECT "storeId", "source", "sourceId", count(*) AS rows_for_key
      INTO conflict
      FROM "DismissedAttentionCard"
     WHERE "source" IS NOT NULL AND "sourceId" IS NOT NULL
     GROUP BY "storeId", "source", "sourceId"
    HAVING count(*) > 1
     ORDER BY count(*) DESC
     LIMIT 1;

    RAISE EXCEPTION
      'ATTENTION DEFERRAL DUPLICATE: % canonical key(s) hold more than one row. First: store=% source=% sourceId=% has % rows. The unique constraint was NOT created and nothing was changed. These are multiple presentation records for one underlying item, never two separate deferrals — reconcile by keeping the latest dismissedAt and removing the rest, deliberately, then re-run.',
      total, conflict."storeId", conflict."source", conflict."sourceId", conflict.rows_for_key;
  END IF;
END
$preflight$;

-- THE PLAIN INDEX FROM THE PREVIOUS MIGRATION IS REDUNDANT once a unique one
-- covers the same columns in the same order. Dropping an index changes no row.
DROP INDEX IF EXISTS "DismissedAttentionCard_storeId_source_sourceId_idx";

-- NULLS ARE DISTINCT IN POSTGRES, which is the behaviour this relies on: every
-- legacy `issue:` and `discovery:` row carries source = NULL and is therefore
-- outside this constraint entirely. They keep working through cardId, which
-- keeps its own unique index.
CREATE UNIQUE INDEX "DismissedAttentionCard_storeId_source_sourceId_key"
  ON "DismissedAttentionCard"("storeId", "source", "sourceId");
