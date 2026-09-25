-- THE ADDRESS A CUSTOMER MAY WRITE TO (2026-09-24)
--
-- ADDITIVE AND NULLABLE, AND THAT IS THE WHOLE DESIGN.
--
-- Every one of the sixteen existing stores keeps contactEmail NULL. There is
-- deliberately no backfill, and in particular no backfill from User.email:
-- that is the address the owner signs in with, and copying it into a column
-- the storefront publishes would disclose it on their behalf. An owner who
-- wants a public address types one; until they do, the storefront shows no
-- contact at all.
--
-- Nothing reads this column as a fallback anywhere. NULL means "not chosen",
-- never "use the account address instead".
--
-- REVERSIBLE WITHOUT LOSS for as long as no owner has set one: the column is
-- new, nothing else references it, and dropping it would return the schema to
-- exactly its previous shape.

ALTER TABLE "Store" ADD COLUMN "contactEmail" TEXT;
