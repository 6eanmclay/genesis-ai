-- TWO QUESTIONS THAT WERE SHARING ONE COLUMN.
--
-- ProductEvent.category is a PRODUCT-ANALYTICS taxonomy: navigation, chat,
-- approval, creation, journey. It answers "what was the person doing".
--
-- What nothing answered is the SYSTEMS question — which part of Genesis did
-- this, and who or what set it going. Adding "storage" and "jobs" to category
-- would put two taxonomies in one column and make both of them wrong: a storage
-- reservation is not a thing a person does, and a navigation event has no
-- subsystem in the same sense.
--
-- So two more columns, each answering one question:
--
--   subsystem   which part of Genesis — execution, storage, jobs, webhooks,
--               integrations, creation, business, j4, api
--   actorKind   who set it going — user, genesis, system, provider, anonymous.
--               userId alone could not distinguish "J4 did this" from "nobody
--               was signed in", which are opposite facts.
--
-- Both nullable: the existing 2,090 rows predate them and cannot honestly be
-- assigned either.
ALTER TABLE "ProductEvent" ADD COLUMN "subsystem" TEXT;
ALTER TABLE "ProductEvent" ADD COLUMN "actorKind" TEXT;

CREATE INDEX "ProductEvent_subsystem_createdAt_idx" ON "ProductEvent"("subsystem", "createdAt");
CREATE INDEX "ProductEvent_name_createdAt_idx"      ON "ProductEvent"("name", "createdAt");
