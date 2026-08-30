-- Corrections that describe themselves.
--
-- StorageEvent recorded what a correction produced, and left what it REPLACED
-- in the reason sentence: "recorded 1589741, provider reports 1593837". An
-- operator could read that; nobody could query it. So the history of a byte
-- count existed only as English inside a text column, which makes "when did
-- this store's usage change, and by how much" a question no query answers.
--
-- Four columns, all nullable, all additive. Existing rows keep NULL, which is
-- honest: nobody recorded those values at the time, and inventing them from the
-- prose would be a guess written into a table whose whole purpose is evidence.
--
-- providerBytes is deliberately NOT merged into sizeInBytes. They coincide for
-- a size correction and for nothing else: an orphan has no ledger value at all,
-- and a missing blob has no provider value. Collapsing them would put the
-- operator back to inferring which meaning applies from `kind`, which is the
-- thing this migration exists to end.
ALTER TABLE "StorageEvent"
  ADD COLUMN "previousBytes"       INTEGER,
  ADD COLUMN "providerBytes"       INTEGER,
  ADD COLUMN "previousStoreId"     TEXT,
  ADD COLUMN "previousAttribution" TEXT;
