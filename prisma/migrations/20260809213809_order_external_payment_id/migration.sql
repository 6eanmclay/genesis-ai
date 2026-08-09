-- AlterTable
ALTER TABLE "Order" ADD COLUMN "externalPaymentId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Order_paymentProvider_externalPaymentId_key" ON "Order"("paymentProvider", "externalPaymentId");
