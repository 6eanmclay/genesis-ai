-- When J4 last evaluated a business.
--
-- ADDITIVE AND NULLABLE. Every existing row reads as "never evaluated", which
-- is the honest state: nothing has been evaluating them on a schedule, and
-- backfilling a timestamp would claim an evaluation that never happened.
--
-- Null also sorts first when choosing which stores are due, so the effect of
-- this migration on the first run after it is that every store is due exactly
-- once — which is correct, and is what the batch deadline is for.
ALTER TABLE "Store" ADD COLUMN "lastIntelligenceAt" TIMESTAMP(3);
