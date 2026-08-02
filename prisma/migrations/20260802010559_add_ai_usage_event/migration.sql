-- CreateTable
CREATE TABLE "AiUsageEvent" (
    "id" TEXT NOT NULL,
    "storeId" TEXT,
    "userId" TEXT,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiUsageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiUsageEvent_storeId_occurredAt_idx" ON "AiUsageEvent"("storeId", "occurredAt");

-- CreateIndex
CREATE INDEX "AiUsageEvent_userId_occurredAt_idx" ON "AiUsageEvent"("userId", "occurredAt");

-- AddForeignKey
ALTER TABLE "AiUsageEvent" ADD CONSTRAINT "AiUsageEvent_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiUsageEvent" ADD CONSTRAINT "AiUsageEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
