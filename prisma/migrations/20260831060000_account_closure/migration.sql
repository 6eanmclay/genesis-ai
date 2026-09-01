-- Account closure is anonymisation, not deletion.
--
-- Additive only. Both columns are nullable, so every existing user reads as
-- open, which is the truth about all of them.
ALTER TABLE "User" ADD COLUMN "closedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "closureReason" TEXT;

-- Closed accounts are looked up as a set by the operator surface and by the
-- suite; a partial index keeps that cheap without indexing every open user.
CREATE INDEX "User_closedAt_idx" ON "User"("closedAt") WHERE "closedAt" IS NOT NULL;
