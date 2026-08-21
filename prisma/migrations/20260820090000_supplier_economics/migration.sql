-- Supplier economics (P0.5).
--
-- Additive. The progression engine could already reason about minimums, bulk
-- pricing and margins; nothing in production could tell it any of them. This is
-- where they live.

CREATE TYPE "EconomicsProvenance" AS ENUM ('SUPPLIER', 'OWNER', 'UNAVAILABLE');

CREATE TABLE "SupplierEconomics" (
  "id" TEXT NOT NULL,
  "storeId" TEXT NOT NULL,
  "sourceKey" TEXT NOT NULL,
  "externalProductId" TEXT NOT NULL,
  "externalVariantId" TEXT NOT NULL DEFAULT '',
  "provenance" "EconomicsProvenance" NOT NULL,
  -- Every figure nullable. Absence is carried through the pipeline as
  -- cannot_assess, never as a free or infinitely-profitable product.
  "unitCostInCents" INTEGER,
  "minimumOrderUnits" INTEGER,
  "tiers" JSONB,
  "shippingPerUnitInCents" INTEGER,
  "leadTimeDays" INTEGER,
  "requiresCapabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "statedByUserId" TEXT,
  "statedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "note" TEXT,

  CONSTRAINT "SupplierEconomics_pkey" PRIMARY KEY ("id")
);

-- IDENTITY IS ALL FOUR PARTS. An external id alone is not an identity: two
-- suppliers can use the same one, and a minimum of 5000 landing on a product
-- whose real minimum is 50 is a wrong number about money nobody would catch.
CREATE UNIQUE INDEX "SupplierEconomics_storeId_sourceKey_externalProductId_extern_key"
  ON "SupplierEconomics" ("storeId", "sourceKey", "externalProductId", "externalVariantId");

CREATE INDEX "SupplierEconomics_storeId_sourceKey_idx"
  ON "SupplierEconomics" ("storeId", "sourceKey");

ALTER TABLE "SupplierEconomics" ADD CONSTRAINT "SupplierEconomics_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
