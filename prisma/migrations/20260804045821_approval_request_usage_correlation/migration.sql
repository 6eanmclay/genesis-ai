-- DropIndex
DROP INDEX "AiUsageEvent_approvalRequestId_idx";

-- AlterTable
ALTER TABLE "AiUsageEvent" DROP COLUMN "approvalRequestId";

-- AlterTable
ALTER TABLE "ApprovalRequest" ADD COLUMN     "aiUsageEventId" TEXT;

-- CreateIndex
CREATE INDEX "ApprovalRequest_aiUsageEventId_idx" ON "ApprovalRequest"("aiUsageEventId");
