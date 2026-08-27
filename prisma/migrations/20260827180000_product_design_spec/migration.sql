-- The Creation Station's design document, on the product it made (2026-08-27).
--
-- ADDITIVE AND NULLABLE. Every existing product keeps NULL, which is the
-- honest value: they were not designed here. No row is rewritten and nothing
-- reads this column unless it is set.
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "designSpec" JSONB;
