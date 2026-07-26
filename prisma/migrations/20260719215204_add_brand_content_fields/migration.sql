-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "richContent" JSONB;

-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "blueprint" JSONB,
ADD COLUMN     "tagline" TEXT;

-- AlterTable
ALTER TABLE "StoreDraft" ADD COLUMN     "tagline" TEXT;
