-- Explicit active business (2026-08-20).
--
-- Additive plus one deterministic backfill. Nothing is dropped, nothing changes
-- type, and no existing row changes meaning.
--
-- WHY. A Genesis account holds several businesses. Until now nothing recorded
-- which one a person was working in: the app resolved "the" business as
-- whichever store was updated most recently, and 47 call sites relied on it. A
-- second business would have become the active one the moment anything touched
-- it -- edit a product in it and orders, connections, billing and Growth Points
-- follow. This column is what makes the answer explicit.

ALTER TABLE "User" ADD COLUMN "activeStoreId" TEXT;

-- SetNull, not Cascade: deleting a business must leave the account working
-- rather than orphaning the person who owned it.
ALTER TABLE "User" ADD CONSTRAINT "User_activeStoreId_fkey"
  FOREIGN KEY ("activeStoreId") REFERENCES "Store"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "User_activeStoreId_idx" ON "User" ("activeStoreId");

-- BACKFILL, and deliberately only the unambiguous case.
--
-- Every account that owns exactly one business gets it as its active one. That
-- is not a guess: with one business there is only one answer, and it is the same
-- answer the old recency lookup was already giving.
--
-- An account owning more than one is left NULL on purpose. There is no correct
-- answer for it, and inventing one here would be the exact recency guess this
-- migration exists to remove -- lib/businessContext.ts treats that state as
-- ambiguous and asks rather than picking. (Verified before writing this: every
-- production account owns exactly one business, so this branch backfills all of
-- them and the NULL case is reachable only in future.)
UPDATE "User" u
SET "activeStoreId" = s.id
FROM "Store" s
WHERE s."userId" = u.id
  AND u."activeStoreId" IS NULL
  AND (SELECT count(*) FROM "Store" s2 WHERE s2."userId" = u.id) = 1;

-- Employees who own no business of their own, but belong to exactly one.
-- Same rule: exactly one accessible business means exactly one answer.
UPDATE "User" u
SET "activeStoreId" = m."storeId"
FROM "StoreMember" m
WHERE m."userId" = u.id
  AND u."activeStoreId" IS NULL
  AND (SELECT count(*) FROM "Store" s2 WHERE s2."userId" = u.id) = 0
  AND (SELECT count(*) FROM "StoreMember" m2 WHERE m2."userId" = u.id) = 1;
