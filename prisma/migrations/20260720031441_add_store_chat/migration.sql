-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "pendingChange" JSONB;

-- CreateTable
CREATE TABLE "StoreMessage" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "changes" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoreMessage_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "StoreMessage" ADD CONSTRAINT "StoreMessage_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
