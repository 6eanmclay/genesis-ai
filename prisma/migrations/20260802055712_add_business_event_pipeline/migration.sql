-- AlterTable
ALTER TABLE "BusinessEvent" ADD COLUMN     "sequence" BIGSERIAL NOT NULL;

-- CreateTable
CREATE TABLE "BusinessEventCursor" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "consumerName" TEXT NOT NULL,
    "lastProcessedSequence" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessEventCursor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BusinessEventCursor_storeId_consumerName_key" ON "BusinessEventCursor"("storeId", "consumerName");

-- CreateIndex
CREATE INDEX "BusinessEvent_storeId_sequence_idx" ON "BusinessEvent"("storeId", "sequence");

-- AddForeignKey
ALTER TABLE "BusinessEventCursor" ADD CONSTRAINT "BusinessEventCursor_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
