-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "fulfilledAt" TIMESTAMP(3),
ADD COLUMN     "fulfillmentStatus" TEXT NOT NULL DEFAULT 'unfulfilled';
