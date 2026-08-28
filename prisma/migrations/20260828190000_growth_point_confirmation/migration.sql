-- "Don't ask me about Growth Points again", made durable.
--
-- Sean, as a GLOBAL rule rather than a Creation Station one: "Include 'Don't
-- ask me about Growth Points again' on that confirmation. If selected, persist
-- that preference so recurring actions can proceed without repeatedly asking."
--
-- On User rather than on Store: it is a fact about how this person wants to be
-- asked, and it should follow them across the businesses they own.
--
-- The COST is stored beside the timestamp because the preference has a limit
-- the rule states outright — "Always override the preference if the cost
-- materially changes". Recording what they agreed to is what makes that
-- checkable rather than a judgement: a 1-point action they waved through does
-- not silently authorise a 10-point one.
--
-- Both nullable, no backfill. Null means "never opted out", which is the truth
-- about every existing account.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "growthPointConfirmSkippedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "growthPointConfirmSkippedCost" INTEGER;
