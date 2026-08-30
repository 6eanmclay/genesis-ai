-- Every time a scheduled task ran, and what came of it.
--
-- Additive only: a new table, no column changed, nothing dropped. A deploy that
-- applies this and a deploy that does not both run the existing cron correctly,
-- because an empty table means every task is due — which is exactly the
-- behaviour of the route before it existed.
CREATE TABLE "ScheduledTaskRun" (
    "id" TEXT NOT NULL,
    "taskKey" TEXT NOT NULL,
    "outcome" TEXT NOT NULL DEFAULT 'running',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "detail" TEXT,
    "trigger" TEXT,
    "correlationId" TEXT,

    CONSTRAINT "ScheduledTaskRun_pkey" PRIMARY KEY ("id")
);

-- The due-ness read path: newest succeeded run for a key.
CREATE INDEX "ScheduledTaskRun_taskKey_outcome_startedAt_idx" ON "ScheduledTaskRun"("taskKey", "outcome", "startedAt");
CREATE INDEX "ScheduledTaskRun_startedAt_idx" ON "ScheduledTaskRun"("startedAt");
CREATE INDEX "ScheduledTaskRun_correlationId_idx" ON "ScheduledTaskRun"("correlationId");
