-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "businessPartnerTrialEndsAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "BusinessPartnerTrialGrant" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "storeName" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessPartnerTrialGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BusinessPartnerTrialGrant_userId_idx" ON "BusinessPartnerTrialGrant"("userId");

-- AddForeignKey
ALTER TABLE "BusinessPartnerTrialGrant" ADD CONSTRAINT "BusinessPartnerTrialGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
