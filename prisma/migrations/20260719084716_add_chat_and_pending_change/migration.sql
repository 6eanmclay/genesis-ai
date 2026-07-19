-- AlterTable
ALTER TABLE "StoreDraft" ADD COLUMN     "pendingChange" JSONB;

-- CreateTable
CREATE TABLE "StoreDraftMessage" (
    "id" TEXT NOT NULL,
    "storeDraftId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "changes" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoreDraftMessage_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "StoreDraftMessage" ADD CONSTRAINT "StoreDraftMessage_storeDraftId_fkey" FOREIGN KEY ("storeDraftId") REFERENCES "StoreDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;
