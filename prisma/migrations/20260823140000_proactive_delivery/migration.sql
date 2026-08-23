-- What J4 has already said out loud (Proactive J4).
--
-- Not a second representation of a finding: GenesisObservation remains the only
-- source of truth for what is true about a business. This records the one fact
-- that row cannot hold — whether J4 has spoken about THIS occurrence of it.
CREATE TABLE "ProactiveDelivery" (
  "id"             TEXT NOT NULL,
  "storeId"        TEXT NOT NULL,
  "observationId"  TEXT NOT NULL,
  "storeMessageId" TEXT NOT NULL,
  "spokenAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closedAt"       TIMESTAMP(3),

  CONSTRAINT "ProactiveDelivery_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProactiveDelivery_storeId_closedAt_idx" ON "ProactiveDelivery"("storeId", "closedAt");
CREATE INDEX "ProactiveDelivery_storeMessageId_idx" ON "ProactiveDelivery"("storeMessageId");

-- IDEMPOTENCY, ENFORCED BY THE DATABASE. Exactly one OPEN delivery per finding,
-- so two cycles racing cannot both speak. Partial rather than plain, because a
-- finding that resolves and later recurs reuses the same observation row
-- (upsertObservation upserts on storeId+dedupeKey) — a plain unique key would
-- mean a finding could never be mentioned a second time, however long the gap.
CREATE UNIQUE INDEX "ProactiveDelivery_open_per_observation"
  ON "ProactiveDelivery"("observationId") WHERE "closedAt" IS NULL;

ALTER TABLE "ProactiveDelivery"
  ADD CONSTRAINT "ProactiveDelivery_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProactiveDelivery"
  ADD CONSTRAINT "ProactiveDelivery_observationId_fkey"
  FOREIGN KEY ("observationId") REFERENCES "GenesisObservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProactiveDelivery"
  ADD CONSTRAINT "ProactiveDelivery_storeMessageId_fkey"
  FOREIGN KEY ("storeMessageId") REFERENCES "StoreMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
