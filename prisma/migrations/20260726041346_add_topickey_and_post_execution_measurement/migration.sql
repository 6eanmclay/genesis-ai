-- AlterTable
ALTER TABLE "ApprovalRequest" ADD COLUMN     "topicKey" TEXT;

-- CreateTable
CREATE TABLE "PostExecutionMeasurement" (
    "id" TEXT NOT NULL,
    "approvalRequestId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "topicKey" TEXT,
    "scope" TEXT NOT NULL,
    "productId" TEXT,
    "windowDays" INTEGER NOT NULL,
    "orderCountBefore" INTEGER NOT NULL,
    "orderCountAfter" INTEGER NOT NULL,
    "revenueBeforeCents" INTEGER,
    "revenueAfterCents" INTEGER,
    "concurrentActionTypes" TEXT[],
    "summary" TEXT NOT NULL,
    "measuredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PostExecutionMeasurement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PostExecutionMeasurement_approvalRequestId_key" ON "PostExecutionMeasurement"("approvalRequestId");

-- CreateIndex
CREATE INDEX "PostExecutionMeasurement_storeId_measuredAt_idx" ON "PostExecutionMeasurement"("storeId", "measuredAt");

-- AddForeignKey
ALTER TABLE "PostExecutionMeasurement" ADD CONSTRAINT "PostExecutionMeasurement_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostExecutionMeasurement" ADD CONSTRAINT "PostExecutionMeasurement_approvalRequestId_fkey" FOREIGN KEY ("approvalRequestId") REFERENCES "ApprovalRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
