-- D4: an approval whose execution started and never resolved.
--
-- The row read PENDING_APPROVAL for the whole duration of an external call, so
-- two callers both passed the read and both executed — a double change and a
-- double growth-point deduction. Claiming the row makes the second lose
-- atomically, in one statement, with no transaction held across the call.
--
-- attemptExecutionId is the durable identity of an attempt. It is minted before
-- execute() runs and handed to it, so the ExecutionLog row that execution
-- writes carries this exact id. That is what lets recovery ask "did THIS
-- attempt finish" rather than inferring from elapsed time — the difference
-- between evidence and a guess, and the whole reason policy (b) is safe.
--
-- claimedAt is NOT a deadline. Recovery reads evidence first; the timestamp
-- exists only so a sweep does not race an execution that is still running.
ALTER TABLE "ApprovalRequest" ADD COLUMN "claimedAt" TIMESTAMP(3);
ALTER TABLE "ApprovalRequest" ADD COLUMN "attemptExecutionId" TEXT;

CREATE INDEX "ApprovalRequest_attemptExecutionId_idx"
  ON "ApprovalRequest"("attemptExecutionId");
