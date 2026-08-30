-- WHAT A SECURITY LAYER WOULD READ.
--
-- SecurityEvent already exists and is not this. Its userId is REQUIRED and it
-- has no storeId, so it can only describe things a known signed-in person did
-- to their own account. That makes it a good account-activity log and unable to
-- represent most of what security means:
--
--   an unauthenticated attacker      — there is no user to attribute it to
--   a cross-store access attempt     — there is no store column
--   an authorization denial          — 13 refusal sites record nothing today
--   a tenant-isolation violation     — it throws an Error and records nothing
--   a system, cron or J4 actor       — the schema assumes a human
--
-- Widening SecurityEvent would spoil the one table with a clean narrow meaning.
-- This is a separate stream, and separate is the point: the eventual security
-- intelligence READS this and holds nothing else. It cannot write here, cannot
-- reach credentials, and cannot widen its own access.
--
-- APPEND ONLY. No updatedAt, no status, no soft delete. A security history that
-- can be edited is a security history that can be edited by whoever got in.
CREATE TABLE "SecuritySignal" (
  "id"            TEXT NOT NULL,
  -- Shared with ExecutionLog, ProductEvent and Job rows from the same unit of
  -- work. This is the column that makes an incident reconstructable instead of
  -- inferred from timestamps.
  "correlationId" TEXT,
  -- Dot-namespaced taxonomy: authz.denied, isolation.violation, webhook.unsigned.
  "kind"          TEXT NOT NULL,
  -- info | warning | critical. What a human should feel about one of these.
  "severity"      TEXT NOT NULL DEFAULT 'info',
  -- user | system | genesis | anonymous | provider. NOT a userId, because the
  -- most interesting actor is frequently not a user at all.
  "actorKind"     TEXT NOT NULL,
  "actorId"       TEXT,
  "storeId"       TEXT,
  -- The route, server action, tool or job this happened in.
  "surface"       TEXT,
  "ipAddress"     TEXT,
  "userAgent"     TEXT,
  "detail"        JSONB,
  "occurredAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SecuritySignal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SecuritySignal_kind_occurredAt_idx"     ON "SecuritySignal"("kind", "occurredAt");
CREATE INDEX "SecuritySignal_severity_occurredAt_idx" ON "SecuritySignal"("severity", "occurredAt");
CREATE INDEX "SecuritySignal_storeId_occurredAt_idx"  ON "SecuritySignal"("storeId", "occurredAt");
CREATE INDEX "SecuritySignal_actorId_occurredAt_idx"  ON "SecuritySignal"("actorId", "occurredAt");
-- Pulling one incident together.
CREATE INDEX "SecuritySignal_correlationId_idx"       ON "SecuritySignal"("correlationId");

-- NO FOREIGN KEYS, deliberately. A signal about a store that was deleted, or an
-- actor who was never a user, must still be recordable — and a delete must
-- never cascade the evidence away with the thing it was evidence about.
