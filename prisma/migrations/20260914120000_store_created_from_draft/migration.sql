-- The idempotency key for confirmStoreDraftCore: which draft/launch produced
-- this store. Nullable, so every existing row and every store created by any
-- other path stays unconstrained (NULLs are distinct in Postgres). Not a
-- foreign key — a successful confirmation deletes the draft, and this has to
-- outlive it.
ALTER TABLE "Store" ADD COLUMN "createdFromDraftId" TEXT;

-- UNIQUE so a concurrent second confirmation of one draft is refused by the
-- database rather than by remembering to check first.
CREATE UNIQUE INDEX "Store_createdFromDraftId_key" ON "Store"("createdFromDraftId");
