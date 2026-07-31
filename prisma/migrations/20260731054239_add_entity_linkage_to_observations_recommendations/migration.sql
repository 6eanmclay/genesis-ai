-- AlterTable
ALTER TABLE "GeneratedRecommendation" ADD COLUMN     "entityType" TEXT,
ADD COLUMN     "recordId" TEXT;

-- AlterTable
ALTER TABLE "GenesisObservation" ADD COLUMN     "entityType" TEXT,
ADD COLUMN     "recordId" TEXT;
