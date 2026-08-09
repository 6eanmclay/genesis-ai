-- CreateTable
CREATE TABLE "DismissedAttentionCard" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "dismissedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dismissedByUserId" TEXT,

    CONSTRAINT "DismissedAttentionCard_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DismissedAttentionCard_storeId_dismissedAt_idx" ON "DismissedAttentionCard"("storeId", "dismissedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DismissedAttentionCard_storeId_cardId_key" ON "DismissedAttentionCard"("storeId", "cardId");

-- AddForeignKey
ALTER TABLE "DismissedAttentionCard" ADD CONSTRAINT "DismissedAttentionCard_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
