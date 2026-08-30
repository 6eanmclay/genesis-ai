-- A durable place for work that should happen and has not happened yet.
--
-- Everything background in this codebase runs inside ONE daily cron tick.
-- Nothing can be scheduled for "in five minutes"; nothing survives a crash
-- mid-way; and ExecutionLog.retryable is written seventy-five times and read by
-- nobody — the system records that an action could be retried and then never
-- retries one.
--
-- idempotencyKey is UNIQUE and is the whole safety story. Enqueueing is
-- therefore naturally idempotent: the same logical unit of work offered twice
-- is one row. That matters most for the case retries create — a handler that
-- charges money or creates a supplier order must not run twice because the
-- first attempt timed out after succeeding.
CREATE TABLE "Job" (
  "id"             TEXT NOT NULL,
  -- Which handler runs this. Looked up in a registry with a runtime
  -- cross-check, per ARCHITECTURE.md's mirrored-registry invariant.
  "kind"           TEXT NOT NULL,
  -- Nullable: some work is platform-wide (reconciliation) rather than a
  -- business's own.
  "storeId"        TEXT,
  "payload"        JSONB NOT NULL DEFAULT '{}',
  "idempotencyKey" TEXT NOT NULL,
  -- pending | running | done | dead
  "status"         TEXT NOT NULL DEFAULT 'pending',
  "attempts"       INTEGER NOT NULL DEFAULT 0,
  "maxAttempts"    INTEGER NOT NULL DEFAULT 5,
  -- Not before this. Backoff moves it forward; scheduling sets it ahead.
  "runAfter"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- A claim, with the runner that holds it. A stale lock is reclaimable, which
  -- is what makes a killed runner recoverable rather than a permanent stall.
  "lockedAt"       TIMESTAMP(3),
  "lockedBy"       TEXT,
  "lastError"      TEXT,
  "completedAt"    TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Job_idempotencyKey_key" ON "Job"("idempotencyKey");
-- The claim query: pending work whose time has come, oldest first.
CREATE INDEX "Job_status_runAfter_idx" ON "Job"("status", "runAfter");
CREATE INDEX "Job_storeId_kind_idx" ON "Job"("storeId", "kind");
CREATE INDEX "Job_kind_status_idx" ON "Job"("kind", "status");
-- Reclaiming a lock a dead runner still holds.
CREATE INDEX "Job_status_lockedAt_idx" ON "Job"("status", "lockedAt");

ALTER TABLE "Job" ADD CONSTRAINT "Job_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
