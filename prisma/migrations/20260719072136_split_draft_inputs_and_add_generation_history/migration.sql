/*
  Warnings:

  - You are about to drop the column `businessDescription` on the `StoreDraft` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "StoreDraft" DROP COLUMN "businessDescription",
ADD COLUMN     "inputProductType" TEXT,
ADD COLUMN     "inputStoreName" TEXT,
ADD COLUMN     "inputVision" TEXT;

-- CreateTable
CREATE TABLE "StoreGeneration" (
    "id" TEXT NOT NULL,
    "storeDraftId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "promptVersion" TEXT NOT NULL DEFAULT 'v1',
    "generatedOutput" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoreGeneration_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "StoreGeneration" ADD CONSTRAINT "StoreGeneration_storeDraftId_fkey" FOREIGN KEY ("storeDraftId") REFERENCES "StoreDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;
