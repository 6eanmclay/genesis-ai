-- AlterTable
ALTER TABLE "ApprovalRequest" ADD COLUMN     "groupId" TEXT;

-- CreateTable
CREATE TABLE "GenesisObservation" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "genesisState" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "actionHref" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "firstNoticedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastConfirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "dismissedAt" TIMESTAMP(3),

    CONSTRAINT "GenesisObservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GenesisObservation_storeId_status_idx" ON "GenesisObservation"("storeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "GenesisObservation_storeId_dedupeKey_key" ON "GenesisObservation"("storeId", "dedupeKey");

-- AddForeignKey
ALTER TABLE "GenesisObservation" ADD CONSTRAINT "GenesisObservation_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
