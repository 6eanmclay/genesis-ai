-- Shipping rate selection at checkout (EasyPost).
--
-- Every column is NULLABLE and additive: no existing row changes meaning, no
-- backfill, no rewrite. An order placed before this migration simply has no
-- customer-selected shipping, which is exactly what was true of it.

-- Parcel dimensions. EasyPost cannot rate a shipment without them, and a
-- guessed weight charges a real customer a wrong price. Per product, because a
-- candle and a bracelet are not the same parcel.
ALTER TABLE "Product" ADD COLUMN "weightOz" DOUBLE PRECISION;
ALTER TABLE "Product" ADD COLUMN "lengthIn" DOUBLE PRECISION;
ALTER TABLE "Product" ADD COLUMN "widthIn" DOUBLE PRECISION;
ALTER TABLE "Product" ADD COLUMN "heightIn" DOUBLE PRECISION;

-- What the CUSTOMER chose and paid for shipping.
--
-- Deliberately separate from Order.shippingCostInCents, which already means
-- "what the label cost the owner" and is read by M7's profitability. The
-- difference between these two numbers IS the store's shipping margin, and
-- collapsing them into one field would destroy that and corrupt M7.
ALTER TABLE "Order" ADD COLUMN "shippingChargedInCents" INTEGER;
ALTER TABLE "Order" ADD COLUMN "selectedShippingCarrier" TEXT;
ALTER TABLE "Order" ADD COLUMN "selectedShippingService" TEXT;
ALTER TABLE "Order" ADD COLUMN "selectedShippingRateId" TEXT;
ALTER TABLE "Order" ADD COLUMN "selectedShippingEstDays" INTEGER;
