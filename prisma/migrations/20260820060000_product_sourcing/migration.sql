-- Product sourcing and discovery (P0.5).
--
-- Additive. Product.sourceKind defaults to OWNER_MADE, which is the truth about
-- every product that exists today: each was entered by hand by the person who
-- makes or holds it. Nothing is backfilled, inferred, or rewritten.

CREATE TYPE "ProductSourceKind" AS ENUM (
  'OWNER_MADE',
  'PRINT_ON_DEMAND',
  'WHOLESALE_DROPSHIP',
  'WHOLESALE_STOCKED',
  'DIGITAL'
);

CREATE TYPE "SourcedProductStatus" AS ENUM ('SUGGESTED', 'DISMISSED', 'ADOPTED');

-- How this product comes into existence and reaches the customer. Distinct from
-- fulfillmentProvider, which records which CONNECTOR a product arrived through
-- and is null for everything an owner makes themselves.
ALTER TABLE "Product" ADD COLUMN "sourceKind" "ProductSourceKind" NOT NULL DEFAULT 'OWNER_MADE';
ALTER TABLE "Product" ADD COLUMN "sourceKey" TEXT;

-- Products Genesis has FOUND, as opposed to products a store sells. Store-scoped
-- because the same supplier listing is a different proposition for a different
-- business, and the reasoning attached to it is about this one.
CREATE TABLE "SourcedProduct" (
  "id" TEXT NOT NULL,
  "storeId" TEXT NOT NULL,
  "sourceKey" TEXT NOT NULL,
  "externalProductId" TEXT NOT NULL,
  -- "" means the source has no variants. NOT NULL because Postgres treats
  -- NULLs in a unique index as distinct, which would have let every re-run of
  -- discovery insert another copy of every variant-less candidate.
  "externalVariantId" TEXT NOT NULL DEFAULT '',
  "kind" "ProductSourceKind" NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "imageUrl" TEXT,
  "unitCostInCents" INTEGER,
  "suggestedRetailInCents" INTEGER,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "customizable" BOOLEAN NOT NULL DEFAULT false,
  -- Which integration will fulfil this, if any. Recorded at discovery so
  -- adoption never re-derives it from a registry that may have moved on.
  "fulfillmentProvider" "IntegrationProvider",
  "recommendation" JSONB,
  "score" INTEGER,
  "status" "SourcedProductStatus" NOT NULL DEFAULT 'SUGGESTED',
  "adoptedProductId" TEXT,
  "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "dismissedAt" TIMESTAMP(3),

  CONSTRAINT "SourcedProduct_pkey" PRIMARY KEY ("id")
);

-- Re-running discovery is an update in place, never a pile of duplicates.
CREATE UNIQUE INDEX "SourcedProduct_storeId_sourceKey_externalProductId_external_key"
  ON "SourcedProduct" ("storeId", "sourceKey", "externalProductId", "externalVariantId");

CREATE INDEX "SourcedProduct_storeId_status_score_idx"
  ON "SourcedProduct" ("storeId", "status", "score");

ALTER TABLE "SourcedProduct" ADD CONSTRAINT "SourcedProduct_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- SetNull, not Cascade: deleting an adopted product must not erase the record
-- that Genesis found it, or discovery would offer the same thing straight back.
ALTER TABLE "SourcedProduct" ADD CONSTRAINT "SourcedProduct_adoptedProductId_fkey"
  FOREIGN KEY ("adoptedProductId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
