-- Square and Xero as IntegrationProviders (2026-08-27).
--
-- ADDITIVE AND NON-DESTRUCTIVE. Two new enum labels; no table is touched and no
-- row is rewritten.
--
-- IF NOT EXISTS because Postgres enum values cannot be added twice, and this
-- repository's migration chain runs against production on every push with no
-- review step. A re-run must be a no-op rather than a failed deploy.
ALTER TYPE "IntegrationProvider" ADD VALUE IF NOT EXISTS 'SQUARE';
ALTER TYPE "IntegrationProvider" ADD VALUE IF NOT EXISTS 'XERO';
