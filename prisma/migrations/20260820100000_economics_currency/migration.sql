-- Currency on supplier economics.
--
-- NOT NULL with no default and no backfill: the table is empty in production
-- (confirmed by counting rows on the live database, not assumed), so there is no
-- row to invent a currency for. A default would have been the invention — every
-- figure recorded from here on says which currency it is in because somebody
-- wrote it down, not because Genesis guessed the business's own.

ALTER TABLE "SupplierEconomics" ADD COLUMN "currency" TEXT NOT NULL;
