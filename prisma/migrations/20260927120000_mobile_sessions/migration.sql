-- THE PHONE SIGNS IN AS A ROW IN THE LIST YOU ALREADY HAVE (2026-09-27)
--
-- MOBILE_SIGN_IN_CONTRACT.md D1, approved. A J4 phone session is a UserSession
-- row with kind = 'mobile' and the SHA-256 of its key in tokenHash, so it shows
-- up in "where am I signed in" and is ended by the same revoke paths, with no
-- new code on either.
--
-- ADDITIVE. Every existing row becomes kind = 'web' through the default and
-- keeps tokenHash NULL; nothing that reads this table today changes behaviour.
-- A unique index on a nullable column admits any number of NULLs in Postgres,
-- so the web rows do not collide.
--
-- REVERSIBLE WITHOUT LOSS until the first phone signs in: dropping both columns
-- returns the table to exactly its previous shape.

ALTER TABLE "UserSession" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'web';
ALTER TABLE "UserSession" ADD COLUMN "tokenHash" TEXT;

CREATE UNIQUE INDEX "UserSession_tokenHash_key" ON "UserSession"("tokenHash");
