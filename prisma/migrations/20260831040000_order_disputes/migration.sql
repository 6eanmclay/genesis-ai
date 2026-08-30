-- A dispute is two facts: what the network claims, and whether money moved.
--
-- Additive only. Every column is nullable and no existing value changes, so an
-- order written before this migration reads exactly as it did — no dispute,
-- which is the truth about all of them.
ALTER TABLE "Order" ADD COLUMN "disputeStatus" TEXT;
ALTER TABLE "Order" ADD COLUMN "disputedAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "disputeResolvedAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "externalDisputeId" TEXT;
ALTER TABLE "Order" ADD COLUMN "disputeAmountInCents" INTEGER;
ALTER TABLE "Order" ADD COLUMN "disputeReason" TEXT;
ALTER TABLE "Order" ADD COLUMN "disputeFundsWithdrawnAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "disputeFundsReinstatedAt" TIMESTAMP(3);

-- A later dispute event names the claim rather than the charge.
CREATE INDEX "Order_externalDisputeId_idx" ON "Order"("externalDisputeId");
