import { randomUUID } from "crypto";
import { CURRENT_EXECUTION_SCHEMA_VERSION, type ExecutionResult, type ExecutionStatus } from "./types";
import { recordExecution } from "./log";

// The lightweight logging hook for Genesis's own AI-driven chat turns
// (applyGenesisMessage / applyGenesisMessageToStore). Deliberately NOT the
// full execute() engine — those functions' tuned two-call generation flow,
// diff tracking, and confirmation logic stay exactly as they are; this only
// records the outcome afterward so AI-driven actions show up in the same
// unified ExecutionLog history as human-triggered ones. See ARCHITECTURE.md
// and PH-03's plan for why full engine adoption for Genesis is deferred.
export async function recordGenesisExecution<TMetadata>(params: {
  action: string;
  status: ExecutionStatus;
  verified: boolean;
  message: string;
  retryable: boolean;
  // Phase 3 Milestone 3 — nullable so lib/intelligence/scheduler.ts's
  // unattended calls (no human session, no userId to attribute this to)
  // can still write a real ExecutionLog row. actorType stays "GENESIS"
  // either way — this is Genesis's own review running, whether triggered
  // by a page load or the scheduler.
  userId: string | null;
  storeId?: string;
  storeDraftId?: string;
  metadata: TMetadata;
  // The row's own id, so a caller that also writes a message can join the two.
}): Promise<{ id: string }> {
  const result: ExecutionResult<TMetadata> = {
    executionId: randomUUID(),
    action: params.action,
    status: params.status,
    verified: params.verified,
    message: params.message,
    retryable: params.retryable,
    actorType: "GENESIS",
    actorId: params.userId,
    storeId: params.storeId ?? null,
    storeDraftId: params.storeDraftId ?? null,
    schemaVersion: CURRENT_EXECUTION_SCHEMA_VERSION,
    timestamp: new Date(),
    metadata: params.metadata,
  };
  return recordExecution(result);
}
