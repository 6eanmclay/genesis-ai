-- AlterTable
ALTER TABLE "Store" ADD COLUMN "returnAddress" JSONB;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "carrier" TEXT,
ADD COLUMN "trackingNumber" TEXT,
ADD COLUMN "trackingUrl" TEXT,
ADD COLUMN "labelUrl" TEXT,
ADD COLUMN "shippingCostInCents" INTEGER;
