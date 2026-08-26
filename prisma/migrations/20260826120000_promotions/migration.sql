-- PROMOTIONS AND DISCOUNT CODES (2026-08-26)
--
-- Additive only. Every column added to "Order" is nullable, so every order
-- already written stays valid and reads as "paid list price, no discount",
-- which is exactly what those orders were.

-- CreateEnum
CREATE TYPE "PromotionKind" AS ENUM ('SALE', 'CODE');

-- CreateEnum
CREATE TYPE "DiscountType" AS ENUM ('PERCENTAGE', 'FIXED_AMOUNT');

-- CreateEnum
CREATE TYPE "PromotionScope" AS ENUM ('ALL_PRODUCTS', 'SELECTED_PRODUCTS');

-- CreateTable
CREATE TABLE "Promotion" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "PromotionKind" NOT NULL,
    "code" TEXT,
    "discountType" "DiscountType" NOT NULL,
    "percentOff" INTEGER,
    "amountOffInCents" INTEGER,
    "scope" "PromotionScope" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Promotion_pkey" PRIMARY KEY ("id")
);

-- A promotion that cannot say how much it takes off is not a generous
-- promotion, it is a broken one. Enforced here rather than only in the form,
-- because orderPricing reads a malformed candidate as zero and the customer
-- would simply be charged full price with no error anyone would ever see.
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_discount_value_present" CHECK (
    ("discountType" = 'PERCENTAGE' AND "percentOff" IS NOT NULL AND "percentOff" > 0 AND "percentOff" <= 100 AND "amountOffInCents" IS NULL)
    OR
    ("discountType" = 'FIXED_AMOUNT' AND "amountOffInCents" IS NOT NULL AND "amountOffInCents" > 0 AND "percentOff" IS NULL)
);

-- A CODE with no code could never be entered; a SALE with one would be a code
-- nobody is told to type. Each kind carries exactly what it needs.
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_code_matches_kind" CHECK (
    ("kind" = 'CODE' AND "code" IS NOT NULL AND length("code") > 0)
    OR
    ("kind" = 'SALE' AND "code" IS NULL)
);

-- A window that closes before it opens would never apply, and is far more
-- likely a typo than an intention.
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_window_ordered" CHECK (
    "startsAt" IS NULL OR "endsAt" IS NULL OR "startsAt" < "endsAt"
);

-- CreateTable
CREATE TABLE "PromotionProduct" (
    "promotionId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,

    CONSTRAINT "PromotionProduct_pkey" PRIMARY KEY ("promotionId","productId")
);

-- CreateIndex
-- NULL codes do not collide in Postgres, so every SALE is exempt from this
-- without needing a partial index: only real codes are held unique per store.
CREATE UNIQUE INDEX "Promotion_storeId_code_key" ON "Promotion"("storeId", "code");

-- CreateIndex
CREATE INDEX "Promotion_storeId_active_idx" ON "Promotion"("storeId", "active");

-- CreateIndex
CREATE INDEX "PromotionProduct_productId_idx" ON "PromotionProduct"("productId");

-- AddForeignKey
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionProduct" ADD CONSTRAINT "PromotionProduct_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "Promotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionProduct" ADD CONSTRAINT "PromotionProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
-- How each order's total was arrived at. Nullable on every existing row, which
-- correctly reads as "list price, nothing taken off".
ALTER TABLE "Order" ADD COLUMN     "listSubtotalInCents" INTEGER,
ADD COLUMN     "discountInCents" INTEGER,
ADD COLUMN     "appliedPromotionId" TEXT,
ADD COLUMN     "appliedPromotionLabel" TEXT,
ADD COLUMN     "appliedPromotionCode" TEXT,
ADD COLUMN     "appliedPromotionKind" "PromotionKind";

-- AddForeignKey
-- SET NULL, never CASCADE. Deleting a promotion must never delete the record of
-- what somebody actually paid; the label, code and amount are copied onto the
-- order so its history survives the promotion entirely.
ALTER TABLE "Order" ADD CONSTRAINT "Order_appliedPromotionId_fkey" FOREIGN KEY ("appliedPromotionId") REFERENCES "Promotion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "Order_appliedPromotionId_idx" ON "Order"("appliedPromotionId");
