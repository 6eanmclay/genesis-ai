-- AlterTable
ALTER TABLE "StoreMessage" ADD COLUMN     "taskId" TEXT;

-- CreateIndex
CREATE INDEX "StoreMessage_taskId_idx" ON "StoreMessage"("taskId");

-- AddForeignKey
ALTER TABLE "StoreMessage" ADD CONSTRAINT "StoreMessage_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;
