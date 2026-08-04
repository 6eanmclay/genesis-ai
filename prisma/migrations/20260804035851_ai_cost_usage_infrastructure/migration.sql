-- AlterTable
ALTER TABLE "AiUsageEvent" ADD COLUMN     "approvalRequestId" TEXT,
ADD COLUMN     "costUsd" DECIMAL(10,6),
ADD COLUMN     "durationMs" INTEGER,
ADD COLUMN     "feature" TEXT,
ADD COLUMN     "growthCreditCost" INTEGER,
ADD COLUMN     "imageCount" INTEGER,
ADD COLUMN     "model" TEXT,
ADD COLUMN     "outcome" TEXT,
ADD COLUMN     "provider" TEXT,
ADD COLUMN     "sessionId" TEXT;

-- CreateIndex
CREATE INDEX "AiUsageEvent_feature_occurredAt_idx" ON "AiUsageEvent"("feature", "occurredAt");

-- CreateIndex
CREATE INDEX "AiUsageEvent_approvalRequestId_idx" ON "AiUsageEvent"("approvalRequestId");
