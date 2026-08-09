-- CreateTable
CREATE TABLE "ProductImage" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductImage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductImage_productId_position_idx" ON "ProductImage"("productId", "position");

-- AddForeignKey
ALTER TABLE "ProductImage" ADD CONSTRAINT "ProductImage_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill (2026-08-08) — one ProductImage row (position 0, the primary)
-- for every existing product's current imageUrl. Preserves every real
-- existing product photo with zero data loss; Product.imageUrl itself is
-- untouched by this migration (it stays the real column, now mirrored by
-- this row going forward).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

INSERT INTO "ProductImage" ("id", "productId", "url", "position", "createdAt")
SELECT gen_random_uuid()::text, "id", "imageUrl", 0, "createdAt"
FROM "Product"
WHERE "imageUrl" IS NOT NULL;
