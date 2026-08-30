-- ONE THREAD THROUGH EVERYTHING ONE REQUEST CAUSES.
--
-- There were three event tables and three ways of tying rows together:
--
--   ExecutionLog    executionId
--   ProductEvent    sessionInstanceId + attemptKey
--   SecurityEvent   sessionInstanceId, and a REQUIRED userId
--
-- No column joined all three, so "a request arrived, J4 executed, verification
-- failed, the owner was told" could not be assembled from the database. Not
-- because the rows were missing — because nothing connected them. An incident
-- was reconstructed by reading timestamps and guessing, which is the method
-- that produces confident wrong answers.
--
-- NULLABLE, AND NOT BACKFILLED. Every existing row predates the id and nothing
-- can honestly say what it belonged to. Inventing one would put a fabricated
-- causal claim in the table whose whole job is evidence. Null means "written
-- before this existed", which is true.
ALTER TABLE "ExecutionLog"    ADD COLUMN "correlationId" TEXT;
ALTER TABLE "ProductEvent"    ADD COLUMN "correlationId" TEXT;
ALTER TABLE "Job"             ADD COLUMN "correlationId" TEXT;
ALTER TABLE "WebhookDelivery" ADD COLUMN "correlationId" TEXT;

-- Pulling one chain together is the only query these serve, so a plain index on
-- the id is the whole requirement.
CREATE INDEX "ExecutionLog_correlationId_idx"    ON "ExecutionLog"("correlationId");
CREATE INDEX "ProductEvent_correlationId_idx"    ON "ProductEvent"("correlationId");
CREATE INDEX "Job_correlationId_idx"             ON "Job"("correlationId");
CREATE INDEX "WebhookDelivery_correlationId_idx" ON "WebhookDelivery"("correlationId");
