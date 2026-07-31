-- CreateTable
CREATE TABLE "Belief" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "topicKey" TEXT NOT NULL,
    "claim" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "evidenceCount" INTEGER NOT NULL,
    "firstObservedAt" TIMESTAMP(3) NOT NULL,
    "lastConfirmedAt" TIMESTAMP(3) NOT NULL,
    "lastContradictedAt" TIMESTAMP(3),
    "evidenceRefs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "data" JSONB,
    "recordId" TEXT,
    "entityType" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "retiredAt" TIMESTAMP(3),
    "retiredReason" TEXT,

    CONSTRAINT "Belief_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Belief_storeId_status_idx" ON "Belief"("storeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Belief_storeId_topicKey_key" ON "Belief"("storeId", "topicKey");

-- AddForeignKey
ALTER TABLE "Belief" ADD CONSTRAINT "Belief_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
