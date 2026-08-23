-- What actually happened when J4 said something (UI6).
--
-- Additive and nullable: every existing row keeps a NULL, which reads as "no
-- execution to speak of" rather than "it succeeded". No backfill, because there
-- is nothing to backfill from — the join did not exist when those rows were
-- written, and inventing one would be inventing history.
--
-- ON DELETE SET NULL: losing the record of what happened must not delete what
-- J4 said about it.
ALTER TABLE "StoreMessage" ADD COLUMN "executionLogId" TEXT;

CREATE INDEX "StoreMessage_executionLogId_idx" ON "StoreMessage"("executionLogId");

ALTER TABLE "StoreMessage"
  ADD CONSTRAINT "StoreMessage_executionLogId_fkey"
  FOREIGN KEY ("executionLogId") REFERENCES "ExecutionLog"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
