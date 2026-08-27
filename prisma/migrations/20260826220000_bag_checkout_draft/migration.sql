-- THE BAG'S SERVER SIDE (2026-08-26)
--
-- Additive only. Browsing still writes nothing — a bag is a cookie. These two
-- tables exist because neither payment provider can carry a multi-product order
-- back to us: PayPal gives us one 127-character custom_id, and Stripe's
-- metadata would cap a bag at an arbitrary size while doing nothing for the
-- other rail. Both rails carry a CheckoutDraft id instead.
--
-- Every column added to "Order" is nullable, so all five existing orders stay
-- valid and unchanged, and none of the 154 call sites reading Order.productId,
-- productName or quantity is touched.

-- CreateEnum
CREATE TYPE "CheckoutDraftStatus" AS ENUM ('OPEN', 'PAYMENT_STARTED', 'CONVERTED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "OrderLineItemSource" AS ENUM ('DRAFT', 'PROVIDER', 'NONE');

-- CreateTable
CREATE TABLE "CheckoutDraft" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "status" "CheckoutDraftStatus" NOT NULL DEFAULT 'OPEN',
    "lines" JSONB NOT NULL,
    "listSubtotalInCents" INTEGER NOT NULL,
    "discountInCents" INTEGER NOT NULL DEFAULT 0,
    "shippingInCents" INTEGER NOT NULL DEFAULT 0,
    "totalInCents" INTEGER NOT NULL,
    "appliedPromotionId" TEXT,
    "appliedPromotionLabel" TEXT,
    "appliedPromotionCode" TEXT,
    "appliedPromotionKind" "PromotionKind",
    "shippingAddress" JSONB,
    "selectedShippingCarrier" TEXT,
    "selectedShippingService" TEXT,
    "selectedShippingRateId" TEXT,
    "paymentProvider" "IntegrationProvider",
    "externalSessionId" TEXT,
    "orderId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CheckoutDraft_pkey" PRIMARY KEY ("id")
);

-- A draft that cannot say what it totals is not a contract. Enforced here as
-- well as in code, because this row is what a charge is reconciled against.
ALTER TABLE "CheckoutDraft" ADD CONSTRAINT "CheckoutDraft_amounts_sane" CHECK (
    "listSubtotalInCents" >= 0
    AND "discountInCents" >= 0
    AND "shippingInCents" >= 0
    AND "totalInCents" >= 0
    AND "discountInCents" <= "listSubtotalInCents"
    AND "totalInCents" = "listSubtotalInCents" - "discountInCents" + "shippingInCents"
);

-- CreateTable
CREATE TABLE "OrderItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "productId" TEXT,
    "productName" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPriceInCents" INTEGER NOT NULL,
    "listInCents" INTEGER NOT NULL,
    "discountInCents" INTEGER NOT NULL DEFAULT 0,
    "subtotalInCents" INTEGER NOT NULL,
    "promotionId" TEXT,
    "promotionLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);

-- The same arithmetic, per line. A line whose subtotal does not follow from its
-- own numbers would appear on a real customer's receipt.
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_amounts_sane" CHECK (
    "quantity" > 0
    AND "unitPriceInCents" >= 0
    AND "discountInCents" >= 0
    AND "listInCents" = "unitPriceInCents" * "quantity"
    AND "discountInCents" <= "listInCents"
    AND "subtotalInCents" = "listInCents" - "discountInCents"
);

-- CreateIndex
CREATE INDEX "CheckoutDraft_storeId_status_idx" ON "CheckoutDraft"("storeId", "status");

-- CreateIndex
CREATE INDEX "CheckoutDraft_externalSessionId_idx" ON "CheckoutDraft"("externalSessionId");

-- CreateIndex
CREATE INDEX "CheckoutDraft_status_expiresAt_idx" ON "CheckoutDraft"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "OrderItem_orderId_idx" ON "OrderItem"("orderId");

-- CreateIndex
CREATE INDEX "OrderItem_productId_idx" ON "OrderItem"("productId");

-- AddForeignKey
ALTER TABLE "CheckoutDraft" ADD CONSTRAINT "CheckoutDraft_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- SET NULL, never CASCADE. A deleted product must not delete the record of what
-- somebody bought; productName above is what keeps the line readable.
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable
-- Nullable on every existing order, which correctly reads as "this predates
-- line items" — each of those has exactly one product recorded on the row.
ALTER TABLE "Order" ADD COLUMN     "lineItemSource" "OrderLineItemSource",
ADD COLUMN     "checkoutDraftId" TEXT;
