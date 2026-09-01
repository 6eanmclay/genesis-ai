-- Where the traffic came from.
--
-- ADDITIVE ONLY. Two new tables and five nullable columns on each of
-- CheckoutDraft and Order, so every existing row reads as "no attribution
-- recorded" — which is the truth about all of them. Nothing is backfilled: an
-- order placed before today has no source, and inventing one would be the
-- exact fabrication this whole subsystem refuses to do.

-- One browsing session on one storefront. Not a person: visitToken is an
-- opaque random value in a per-store cookie, and there is deliberately no
-- column for an IP address, a user agent, or anything cross-store.
CREATE TABLE "StoreVisit" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "visitToken" TEXT NOT NULL,
    "attributionKind" TEXT NOT NULL,
    "source" TEXT,
    "campaign" TEXT,
    "evidence" TEXT NOT NULL,
    "landingPath" TEXT NOT NULL,
    "viewedProductIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoreVisit_pkey" PRIMARY KEY ("id")
);

-- A refresh is the same visit. This unique constraint is what makes recording
-- idempotent rather than a check-then-act race.
CREATE UNIQUE INDEX "StoreVisit_storeId_visitToken_key" ON "StoreVisit"("storeId", "visitToken");
CREATE INDEX "StoreVisit_storeId_firstSeenAt_idx" ON "StoreVisit"("storeId", "firstSeenAt");
CREATE INDEX "StoreVisit_storeId_attributionKind_idx" ON "StoreVisit"("storeId", "attributionKind");
CREATE INDEX "StoreVisit_storeId_source_idx" ON "StoreVisit"("storeId", "source");

ALTER TABLE "StoreVisit" ADD CONSTRAINT "StoreVisit_storeId_fkey"
    FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Traffic that outlives the visits it was counted from. Raw visits are pruned
-- at twelve months; orders keep their own frozen attribution for ever, so
-- revenue by source survives on its own. What would not survive is the visit
-- COUNT, and without it there is no conversion rate and no revenue per visitor.
CREATE TABLE "StoreTrafficDay" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "day" TIMESTAMP(3) NOT NULL,
    "attributionKind" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT '',
    "visits" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "StoreTrafficDay_pkey" PRIMARY KEY ("id")
);

-- `source` is NOT NULL here, unlike on StoreVisit, and empty means direct.
-- Nulls are distinct in a Postgres unique index, so a nullable column would
-- insert a new row for the direct count on every rollup rather than updating
-- the one that exists. NULLS NOT DISTINCT would fix it and Prisma cannot
-- declare it, which would leave the schema and this file disagreeing.
CREATE UNIQUE INDEX "StoreTrafficDay_storeId_day_attributionKind_source_key"
    ON "StoreTrafficDay"("storeId", "day", "attributionKind", "source");
CREATE INDEX "StoreTrafficDay_storeId_day_idx" ON "StoreTrafficDay"("storeId", "day");

ALTER TABLE "StoreTrafficDay" ADD CONSTRAINT "StoreTrafficDay_storeId_fkey"
    FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The frozen attribution. COPIES, not foreign keys — stripeEvent.ts says why in
-- its own words about the promotion link: a referenced row deleted between a
-- customer paying and the webhook arriving makes order.create violate the
-- constraint, and "the ENTIRE order is lost -- money taken, nothing recorded".
ALTER TABLE "CheckoutDraft" ADD COLUMN "attributionKind" TEXT;
ALTER TABLE "CheckoutDraft" ADD COLUMN "attributionSource" TEXT;
ALTER TABLE "CheckoutDraft" ADD COLUMN "attributionCampaign" TEXT;
ALTER TABLE "CheckoutDraft" ADD COLUMN "attributionEvidence" TEXT;
ALTER TABLE "CheckoutDraft" ADD COLUMN "attributionVisitId" TEXT;

ALTER TABLE "Order" ADD COLUMN "attributionKind" TEXT;
ALTER TABLE "Order" ADD COLUMN "attributionSource" TEXT;
ALTER TABLE "Order" ADD COLUMN "attributionCampaign" TEXT;
ALTER TABLE "Order" ADD COLUMN "attributionEvidence" TEXT;
ALTER TABLE "Order" ADD COLUMN "attributionVisitId" TEXT;

-- Revenue by source is the question this whole milestone exists to answer.
CREATE INDEX "Order_storeId_attributionSource_idx" ON "Order"("storeId", "attributionSource");
