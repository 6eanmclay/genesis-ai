-- What an unattended sourcing run actually spent, on a third axis of its own.
--
-- Not AiUsageEvent: every column of that table is about tokens and models, and a
-- network call to a supplier has neither. Not GrowthPointTransaction: charging
-- an owner for work Genesis chose to do unprompted would be a lie that balances.
--
-- Additive. Nothing reads it yet except the ledger itself.

CREATE TABLE "SupplierRequestEvent" (
  "id"         TEXT NOT NULL,
  "storeId"    TEXT,
  "sourceKey"  TEXT NOT NULL,
  "operation"  TEXT NOT NULL,
  "ok"         BOOLEAN NOT NULL,
  "durationMs" INTEGER NOT NULL,
  -- Null when a person triggered the call. What separates "Genesis spent this
  -- on its own initiative" from "somebody asked for it".
  "runId"      TEXT,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SupplierRequestEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SupplierRequestEvent_storeId_occurredAt_idx"
  ON "SupplierRequestEvent" ("storeId", "occurredAt");
CREATE INDEX "SupplierRequestEvent_runId_idx" ON "SupplierRequestEvent" ("runId");
