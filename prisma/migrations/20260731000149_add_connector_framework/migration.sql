-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "IntegrationProvider" ADD VALUE 'GOOGLE_CALENDAR';
ALTER TYPE "IntegrationProvider" ADD VALUE 'QUICKBOOKS';
ALTER TYPE "IntegrationProvider" ADD VALUE 'MAILCHIMP';

-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "businessCategories" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "StoreDraft" ADD COLUMN     "businessCategories" TEXT[] DEFAULT ARRAY[]::TEXT[];
