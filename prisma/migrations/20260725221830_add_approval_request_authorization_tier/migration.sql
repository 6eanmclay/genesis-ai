-- AlterTable
ALTER TABLE "ApprovalRequest" ADD COLUMN     "authorizationTier" TEXT NOT NULL DEFAULT 'always_ask';
