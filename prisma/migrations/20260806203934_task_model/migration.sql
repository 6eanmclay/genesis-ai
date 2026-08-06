-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceId" TEXT,
    "relatedRecordId" TEXT,
    "relatedEntityType" TEXT,
    "relatedAssetId" TEXT,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "context" JSONB NOT NULL,
    "actionType" TEXT,
    "trustLevel" TEXT NOT NULL DEFAULT 'recommend',
    "requiredInput" JSONB,
    "actionHref" TEXT,
    "priority" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "seedMessageId" TEXT,
    "completedAt" TIMESTAMP(3),
    "dismissedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Task_storeId_status_idx" ON "Task"("storeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Task_storeId_dedupeKey_key" ON "Task"("storeId", "dedupeKey");

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
