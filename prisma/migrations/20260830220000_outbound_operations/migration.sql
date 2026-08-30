-- ONE EXTERNAL SIDE EFFECT, PERFORMED ONCE.
--
-- lib/dashboard/approvalRecovery.ts already names this gap in a comment:
--
--   "The one case this cannot distinguish is a process dying after the provider
--    succeeded and before the engine recorded it. No row exists, so this
--    releases and a retry repeats the provider work. Closing that needs an
--    idempotency key at each provider — deliberately out of scope."
--
-- It is in scope now, because the durable job queue made retries real. Retries
-- without this turn one bug into two: the original failure, plus a second
-- supplier order placed when the first attempt timed out after succeeding.
--
-- ============ THE KEY IS NOT PROOF ==================================
--
-- A row is claimed BEFORE the provider is called, so a process that dies
-- mid-call leaves a claim with no answer. That state is `indeterminate` and it
-- is the honest one: we do not know whether the provider acted. It is NEVER
-- auto-retried, because retrying might duplicate and abandoning might lose. It
-- is resolved by asking the provider — externalRef, below, is what proof
-- actually looks like — or by a person.
--
-- Three private idempotency implementations already exist (growth points,
-- customer notification, owner notification, each subtly different). This is
-- the shared one that future providers use instead of adding a fourth.
CREATE TABLE "OutboundOperation" (
  "id"             TEXT NOT NULL,
  -- Caller-supplied and describing WHAT is to be done, never when it was asked.
  -- "printful.order:ord_123" is right; a uuid is wrong, because two callers
  -- racing to place the same order must collide.
  "idempotencyKey" TEXT NOT NULL,
  -- "printful.createOrder" — groups operations and selects a reconciler.
  "operation"      TEXT NOT NULL,
  "storeId"        TEXT,
  "correlationId"  TEXT,
  -- in_progress | succeeded | failed | indeterminate
  "status"         TEXT NOT NULL DEFAULT 'in_progress',
  "attempts"       INTEGER NOT NULL DEFAULT 0,
  -- THE PROVIDER'S OWN ID. This, and not our key, is evidence the thing exists.
  "externalRef"    TEXT,
  -- The answer the first successful call produced, so a replay returns what the
  -- caller would have got rather than a second call's answer.
  "result"         JSONB,
  "lastError"      TEXT,
  -- A live claim. Stale means the runner died mid-call, which is indeterminate.
  "claimedAt"      TIMESTAMP(3),
  "claimedBy"      TEXT,
  "completedAt"    TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OutboundOperation_pkey" PRIMARY KEY ("id")
);

-- The whole safety story in one constraint.
CREATE UNIQUE INDEX "OutboundOperation_idempotencyKey_key" ON "OutboundOperation"("idempotencyKey");
CREATE INDEX "OutboundOperation_status_claimedAt_idx"  ON "OutboundOperation"("status", "claimedAt");
CREATE INDEX "OutboundOperation_operation_status_idx"  ON "OutboundOperation"("operation", "status");
CREATE INDEX "OutboundOperation_storeId_createdAt_idx" ON "OutboundOperation"("storeId", "createdAt");
CREATE INDEX "OutboundOperation_correlationId_idx"     ON "OutboundOperation"("correlationId");

-- SetNull, not Cascade: the record that money left the building outlives the
-- store it left on behalf of.
ALTER TABLE "OutboundOperation" ADD CONSTRAINT "OutboundOperation_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE SET NULL ON UPDATE CASCADE;
