-- AlterTable
ALTER TABLE "ExecutionLog" ADD COLUMN     "storeDraftId" TEXT,
ALTER COLUMN "storeId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "ExecutionLog" ADD CONSTRAINT "ExecutionLog_storeDraftId_fkey" FOREIGN KEY ("storeDraftId") REFERENCES "StoreDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;
