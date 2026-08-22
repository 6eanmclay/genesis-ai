-- Telling the OWNER a sale happened (P1.8 of the Cubit & Coil Live milestone:
-- "new-order notification (owner)").
--
-- Additive and nullable, the same shape as confirmationSentAt and
-- shipmentNotifiedAt beside it. Null means the owner has not been told, which
-- is true of every order written before this column existed — and is the honest
-- reading rather than backfilling a claim that nobody was ever emailed.
ALTER TABLE "Order" ADD COLUMN "ownerNotifiedAt" TIMESTAMP(3);
