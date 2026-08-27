-- AliExpress as an IntegrationProvider (2026-08-27).
--
-- ADDITIVE AND NON-DESTRUCTIVE. One new enum label; no table is touched, no row
-- is rewritten, and nothing that exists today reads or writes it.
--
-- IF NOT EXISTS because Postgres enum values cannot be added twice, and this
-- repository's migration chain runs against production on every push with no
-- review step. A re-run must be a no-op rather than a failed deploy.
ALTER TYPE "IntegrationProvider" ADD VALUE IF NOT EXISTS 'ALIEXPRESS';
