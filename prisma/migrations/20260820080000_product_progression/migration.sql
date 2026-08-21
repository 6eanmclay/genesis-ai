-- Product progression (P0.5, units 1-4 and 8).
--
-- Additive throughout. No existing row changes meaning, and the one default that
-- touches existing data records what was already true rather than inventing a
-- value -- see Order.quantity below.

-- Rungs 2 and 3. Deliberately added with no connector behind either: the rung
-- has to exist in the model before a supplier for it does, or one supplier's
-- shape ends up dictating the architecture. Postgres enums only append.
ALTER TYPE "ProductSourceKind" ADD VALUE IF NOT EXISTS 'PRIVATE_LABEL';
ALTER TYPE "ProductSourceKind" ADD VALUE IF NOT EXISTS 'CONTRACT_MANUFACTURED';

-- The business's own currency. Every money value belonging to a business is in
-- it. One per business, and the assumption is named here rather than assumed
-- everywhere, so lifting it later is contained rather than an excavation.
ALTER TABLE "Store" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'USD';

-- What the owner has SAID they can invest. Never inferred from revenue: a
-- business with real sales may have nothing spare, and recommending a bulk
-- order on the strength of turnover would be telling somebody to spend money
-- Genesis has no idea they have.
--
-- NULL means UNSTATED, which is not the same fact as a stated zero even though
-- both behave identically. The pair of columns keeps three states apart, and
-- collapsing the first two would destroy the only signal that says "worth
-- asking about".
ALTER TABLE "Store" ADD COLUMN "investableCapitalCents" INTEGER;
ALTER TABLE "Store" ADD COLUMN "capitalStatedAt" TIMESTAMP(3);
ALTER TABLE "Store" ADD COLUMN "ownerCapabilities" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Supplier economics, as stated by the supplier. NULL is unknown throughout and
-- is never defaulted to zero: an unknown minimum blocks a recommendation rather
-- than becoming a free one.
ALTER TABLE "SourcedProduct" ADD COLUMN "minimumOrderUnits" INTEGER;
ALTER TABLE "SourcedProduct" ADD COLUMN "bulkUnitCostInCents" INTEGER;
ALTER TABLE "SourcedProduct" ADD COLUMN "leadTimeDays" INTEGER;

-- HOW MANY UNITS AN ORDER IS FOR.
--
-- Progression evidence counts units, not orders: one order for 100 is not the
-- same evidence as 100 orders for one, and a bulk-purchase recommendation built
-- on the wrong one would tell an owner to buy a case on the strength of a single
-- sale.
--
-- The default of 1 is not a guess. Every order this platform has written came
-- from a checkout selling one product with no quantity control, so each is
-- genuinely one unit. amountInCents remains the ORDER TOTAL.
ALTER TABLE "Order" ADD COLUMN "quantity" INTEGER NOT NULL DEFAULT 1;

-- The owner's answer to a graduation, so it is not offered again next week.
CREATE TYPE "ProgressionDecisionKind" AS ENUM ('ACCEPTED', 'DECLINED');

CREATE TABLE "ProgressionDecision" (
  "id" TEXT NOT NULL,
  "storeId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "toKind" "ProductSourceKind" NOT NULL,
  "decision" "ProgressionDecisionKind" NOT NULL,
  -- Which policy version produced the offer. A later threshold change does not
  -- rewrite this; it means the next offer was judged differently.
  "policyVersion" TEXT NOT NULL,
  -- The conditions as they stood, not just the evidence. This is what "has
  -- anything material changed" is answered against.
  "conditions" JSONB NOT NULL,
  "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ProgressionDecision_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProgressionDecision_storeId_productId_idx"
  ON "ProgressionDecision" ("storeId", "productId");

ALTER TABLE "ProgressionDecision" ADD CONSTRAINT "ProgressionDecision_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProgressionDecision" ADD CONSTRAINT "ProgressionDecision_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
