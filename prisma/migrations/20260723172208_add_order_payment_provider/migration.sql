-- Rename the Stripe-specific column to a provider-agnostic one, preserving
-- existing rows (a plain DROP+ADD, which Prisma's naive diff would have
-- generated, would have destroyed real order data).
ALTER TABLE "Order" RENAME COLUMN "stripeSessionId" TO "externalOrderId";

DROP INDEX "Order_stripeSessionId_key";

-- Add paymentProvider with a temporary default so every existing row
-- (all of which are in fact Stripe orders) backfills correctly, then drop
-- the default so future inserts must supply it explicitly.
ALTER TABLE "Order" ADD COLUMN "paymentProvider" "IntegrationProvider" NOT NULL DEFAULT 'STRIPE';
ALTER TABLE "Order" ALTER COLUMN "paymentProvider" DROP DEFAULT;

-- Composite unique instead of a bare unique on externalOrderId, so two
-- providers' ids can never collide.
CREATE UNIQUE INDEX "Order_paymentProvider_externalOrderId_key" ON "Order"("paymentProvider", "externalOrderId");
