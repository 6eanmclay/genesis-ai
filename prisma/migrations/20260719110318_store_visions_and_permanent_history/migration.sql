-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "StoreGeneration" ADD COLUMN     "milestone" TEXT,
ADD COLUMN     "storeId" TEXT,
ALTER COLUMN "storeDraftId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "StoreGeneration" ADD CONSTRAINT "StoreGeneration_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
