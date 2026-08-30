-- Slice 2 step 2 — where an allowance lives.
--
-- STORAGE.md §9, locked 2026-08-28: $20 → 5 GB, $50 → 15 GB, $100 Pro → 50 GB.
-- Data rather than a constant so an allowance can change without a deploy.
--
-- Nullable only so the column can exist before it is seeded. The UPDATEs below
-- fill the three real plans; a plan with no allowance is a misconfiguration the
-- suite asserts against, not a silent zero.
ALTER TABLE "Plan" ADD COLUMN "includedStorageBytes" BIGINT;

-- 5 / 15 / 50 GB. Matched by name against the three plans that exist.
UPDATE "Plan" SET "includedStorageBytes" = 5368709120  WHERE "name" = 'Starter';
UPDATE "Plan" SET "includedStorageBytes" = 16106127360 WHERE "name" = 'Growth';
UPDATE "Plan" SET "includedStorageBytes" = 53687091200 WHERE "name" = 'Business Partner';

-- Stores with no plan are NOT assigned one. They resolve to Starter's
-- allowance at read time — see lib/storage/allowance.ts. planId stays null.
