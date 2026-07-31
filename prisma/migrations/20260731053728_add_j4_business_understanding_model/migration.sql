-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "revenueStreams" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "StoreDraft" ADD COLUMN     "revenueStreams" TEXT[] DEFAULT ARRAY[]::TEXT[];
