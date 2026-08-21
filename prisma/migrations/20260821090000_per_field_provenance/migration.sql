-- Per-field provenance on supplier economics.
--
-- One row, several facts, and they do not arrive together: a catalogue can
-- publish a price and say nothing about the minimum, and the owner then rings
-- and is told the minimum. Under one provenance column those two could not
-- coexist -- the owner's answer either overwrote the supplier's price or was
-- stamped with the supplier's name, and both are lies about where a number
-- about somebody's money came from.
--
-- DESTRUCTIVE BY DESIGN, AND SAFE BECAUSE THE TABLE IS EMPTY. Row count in
-- production confirmed 0 by querying the live database, not assumed. There is
-- no row whose single provenance would have to be spread across five facts, so
-- there is no migration that would have to guess which fact the old value
-- described -- and guessing that is precisely the thing this change exists to
-- stop. If rows ever exist, this file must not be re-run as-is.

ALTER TABLE "SupplierEconomics"
  ADD COLUMN "minimumOrderProvenance" "EconomicsProvenance",
  ADD COLUMN "minimumOrderStatedAt"   TIMESTAMP(3),
  ADD COLUMN "minimumOrderStatedById" TEXT,

  ADD COLUMN "unitCostProvenance" "EconomicsProvenance",
  ADD COLUMN "unitCostStatedAt"   TIMESTAMP(3),
  ADD COLUMN "unitCostStatedById" TEXT,

  ADD COLUMN "tiersProvenance" "EconomicsProvenance",
  ADD COLUMN "tiersStatedAt"   TIMESTAMP(3),
  ADD COLUMN "tiersStatedById" TEXT,

  ADD COLUMN "shippingProvenance" "EconomicsProvenance",
  ADD COLUMN "shippingStatedAt"   TIMESTAMP(3),
  ADD COLUMN "shippingStatedById" TEXT,

  ADD COLUMN "handlingProvenance" "EconomicsProvenance",
  ADD COLUMN "handlingStatedAt"   TIMESTAMP(3),
  ADD COLUMN "handlingStatedById" TEXT,

  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- The row-level trio is gone. "Who last wrote this row" answered a question
-- nothing should have been asking: every decision needs to know who stated the
-- particular figure it is about.
ALTER TABLE "SupplierEconomics"
  DROP COLUMN "provenance",
  DROP COLUMN "statedAt",
  DROP COLUMN "statedByUserId";
