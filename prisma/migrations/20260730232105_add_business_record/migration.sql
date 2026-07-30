-- CreateTable
CREATE TABLE "BusinessRecord" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "sourceProvider" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BusinessRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BusinessRecord_storeId_entityType_idx" ON "BusinessRecord"("storeId", "entityType");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessRecord_storeId_entityType_sourceProvider_externalId_key" ON "BusinessRecord"("storeId", "entityType", "sourceProvider", "externalId");

-- AddForeignKey
ALTER TABLE "BusinessRecord" ADD CONSTRAINT "BusinessRecord_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
