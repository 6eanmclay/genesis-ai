-- AlterTable
ALTER TABLE "AiUsageEvent" DROP COLUMN "growthCreditCost",
ADD COLUMN     "businessIntent" TEXT,
ADD COLUMN     "growthCreditValue" INTEGER;
