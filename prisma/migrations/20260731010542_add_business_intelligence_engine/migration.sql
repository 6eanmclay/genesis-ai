-- AlterTable
ALTER TABLE "StoreIntegration" ADD COLUMN     "lastSyncedAt" TIMESTAMP(3),
ADD COLUMN     "nextSyncDueAt" TIMESTAMP(3),
ADD COLUMN     "syncFailureCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "BusinessEvent" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "recordId" TEXT,
    "sourceProvider" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "data" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "BusinessEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BusinessEvent_storeId_occurredAt_idx" ON "BusinessEvent"("storeId", "occurredAt");

-- CreateIndex
CREATE INDEX "BusinessEvent_storeId_processedAt_idx" ON "BusinessEvent"("storeId", "processedAt");

-- CreateIndex
CREATE INDEX "StoreIntegration_status_nextSyncDueAt_idx" ON "StoreIntegration"("status", "nextSyncDueAt");

-- AddForeignKey
ALTER TABLE "BusinessEvent" ADD CONSTRAINT "BusinessEvent_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
