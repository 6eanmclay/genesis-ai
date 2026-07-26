import { prisma } from "@/lib/prisma";
import { CURRENT_EXECUTION_SCHEMA_VERSION, type ExecutionResult } from "./types";

// The only place ExecutionLog gets written. Append-only, by convention: this
// file only ever calls .create() — never .update() — so a logical request's
// status changing over time (e.g. PENDING -> SUCCESS) always becomes a new
// row sharing `executionId`, never a mutated one. See ARCHITECTURE.md.
export async function recordExecution<TMetadata>(
  result: ExecutionResult<TMetadata>
): Promise<void> {
  await prisma.executionLog.create({
    data: {
      executionId: result.executionId,
      storeId: result.storeId,
      storeDraftId: result.storeDraftId,
      action: result.action,
      status: result.status,
      verified: result.verified,
      message: result.message,
      retryable: result.retryable,
      actorType: result.actorType,
      actorId: result.actorId,
      schemaVersion: result.schemaVersion ?? CURRENT_EXECUTION_SCHEMA_VERSION,
      metadata: result.metadata === undefined ? undefined : (result.metadata as object),
    },
  });
}
