-- AlterEnum
ALTER TYPE "IntegrationProvider" ADD VALUE 'PRINTFUL';

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "costInCents" INTEGER,
ADD COLUMN     "externalProductId" TEXT,
ADD COLUMN     "externalVariantId" TEXT,
ADD COLUMN     "fulfillmentProvider" "IntegrationProvider";

-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "brandPositioning" TEXT;

-- AlterTable
ALTER TABLE "StoreDraft" ADD COLUMN     "brandPositioning" TEXT,
ADD COLUMN     "onboardingState" JSONB;
