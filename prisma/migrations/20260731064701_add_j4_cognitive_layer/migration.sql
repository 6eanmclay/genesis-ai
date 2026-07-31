-- AlterTable
ALTER TABLE "ApprovalRequest" ADD COLUMN     "cognitiveOutputId" TEXT;

-- CreateTable
CREATE TABLE "CognitiveOutput" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "data" JSONB,
    "priority" TEXT,
    "recordId" TEXT,
    "entityType" TEXT,
    "relatedOutputIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "topicKey" TEXT,
    "proposedAction" JSONB,
    "approvalRequestId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "CognitiveOutput_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CognitiveOutput_storeId_kind_idx" ON "CognitiveOutput"("storeId", "kind");

-- CreateIndex
CREATE INDEX "CognitiveOutput_storeId_status_idx" ON "CognitiveOutput"("storeId", "status");

-- CreateIndex
CREATE INDEX "CognitiveOutput_storeId_recordId_idx" ON "CognitiveOutput"("storeId", "recordId");

-- AddForeignKey
ALTER TABLE "CognitiveOutput" ADD CONSTRAINT "CognitiveOutput_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
