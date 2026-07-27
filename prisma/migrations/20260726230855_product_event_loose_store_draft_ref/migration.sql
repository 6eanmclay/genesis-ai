-- A StoreDraft is deleted as the normal, successful terminal step of the
-- creation journey (confirmStoreDraft) — not an edge case. A hard FK on
-- ProductEvent.storeDraftId either cascade-deletes the very creation.*
-- history this table exists to preserve, or rejects the "creation.confirmed"
-- event's own insert (written after that delete). Drop the constraint;
-- the column and any existing data are untouched — this becomes a loose
-- reference, same pattern as ApprovalRequest.recommendationId.
ALTER TABLE "ProductEvent" DROP CONSTRAINT "ProductEvent_storeDraftId_fkey";
