-- AlterTable
ALTER TABLE "StoreDraft" ADD COLUMN     "anonymousSessionToken" TEXT,
ALTER COLUMN "userId" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "StoreDraft_anonymousSessionToken_key" ON "StoreDraft"("anonymousSessionToken");
