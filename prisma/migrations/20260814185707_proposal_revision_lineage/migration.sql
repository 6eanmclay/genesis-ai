-- AlterTable
ALTER TABLE "ApprovalRequest" ADD COLUMN     "proposalId" TEXT,
ADD COLUMN     "rationale" TEXT,
ADD COLUMN     "revision" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "scope" TEXT,
ADD COLUMN     "supersedesId" TEXT;

-- CreateIndex
CREATE INDEX "ApprovalRequest_proposalId_revision_idx" ON "ApprovalRequest"("proposalId", "revision");
