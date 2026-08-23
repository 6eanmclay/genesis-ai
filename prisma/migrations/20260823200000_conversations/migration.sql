-- UI6 piece 2: a conversation is an explicit, persistent thread.
--
-- Not a task and not a time window. An anchor (taskId) is optional metadata;
-- identity is the row itself, so a conversation about a product, a customer or a
-- document does not have to become a task in order to exist.
CREATE TABLE "Conversation" (
  "id"        TEXT NOT NULL,
  "storeId"   TEXT NOT NULL,
  "name"      TEXT,
  "taskId"    TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Conversation_storeId_createdAt_idx" ON "Conversation"("storeId", "createdAt");
CREATE INDEX "Conversation_taskId_idx" ON "Conversation"("taskId");

ALTER TABLE "Conversation"
  ADD CONSTRAINT "Conversation_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- SET NULL, deliberately. The anchor is context, never identity: deleting the
-- task it points at must leave the conversation and every message in it exactly
-- where they are.
ALTER TABLE "Conversation"
  ADD CONSTRAINT "Conversation_taskId_fkey"
  FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Nullable and NEVER backfilled. Every existing message keeps a null, which
-- means "no conversation was recorded" — not a manufactured one. The grouping
-- did not exist when those rows were written and inventing one is inventing
-- history.
ALTER TABLE "StoreMessage" ADD COLUMN "conversationId" TEXT;

CREATE INDEX "StoreMessage_conversationId_idx" ON "StoreMessage"("conversationId");

ALTER TABLE "StoreMessage"
  ADD CONSTRAINT "StoreMessage_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
