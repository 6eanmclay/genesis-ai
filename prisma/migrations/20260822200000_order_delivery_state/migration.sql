-- Shipping & Fulfilment: where the parcel actually is, from the carrier itself.
ALTER TABLE "Order" ADD COLUMN "shipmentStatus" TEXT;
ALTER TABLE "Order" ADD COLUMN "deliveredAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "lastScanAt" TIMESTAMP(3);
