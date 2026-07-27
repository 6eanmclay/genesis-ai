-- CreateTable
CREATE TABLE "ProductEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "storeId" TEXT,
    "storeDraftId" TEXT,
    "sessionInstanceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "attemptKey" TEXT,
    "outcome" TEXT,
    "durationMs" INTEGER,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductEvent_userId_createdAt_idx" ON "ProductEvent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ProductEvent_sessionInstanceId_createdAt_idx" ON "ProductEvent"("sessionInstanceId", "createdAt");

-- CreateIndex
CREATE INDEX "ProductEvent_attemptKey_idx" ON "ProductEvent"("attemptKey");

-- CreateIndex
CREATE INDEX "ProductEvent_storeId_createdAt_idx" ON "ProductEvent"("storeId", "createdAt");

-- AddForeignKey
ALTER TABLE "ProductEvent" ADD CONSTRAINT "ProductEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductEvent" ADD CONSTRAINT "ProductEvent_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductEvent" ADD CONSTRAINT "ProductEvent_storeDraftId_fkey" FOREIGN KEY ("storeDraftId") REFERENCES "StoreDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;
