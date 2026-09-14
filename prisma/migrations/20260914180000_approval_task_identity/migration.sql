-- Which Task an approval came out of, when it came out of one.
--
-- Nullable because most approvals do not originate in a task, and every
-- existing row keeps a null that means exactly that. Not a foreign key: a
-- deleted Task must not cascade into deleting an approval that really
-- happened, and a dangling id honestly means the task is gone.
ALTER TABLE "ApprovalRequest" ADD COLUMN "taskId" TEXT;

-- Completion looks an approval up by its task, so the lookup is indexed.
CREATE INDEX "ApprovalRequest_taskId_idx" ON "ApprovalRequest"("taskId");
