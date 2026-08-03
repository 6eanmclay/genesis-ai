-- AlterTable
ALTER TABLE "AiUsageEvent" ADD COLUMN     "anonymousSessionToken" TEXT;

-- AlterTable
ALTER TABLE "StoreDraft" ADD COLUMN     "experienceState" JSONB;

-- CreateIndex
CREATE INDEX "AiUsageEvent_anonymousSessionToken_occurredAt_idx" ON "AiUsageEvent"("anonymousSessionToken", "occurredAt");
