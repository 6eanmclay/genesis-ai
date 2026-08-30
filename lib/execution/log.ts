import { prisma } from "@/lib/prisma";
import { correlationId } from "@/lib/observability/correlation";
import { CURRENT_EXECUTION_SCHEMA_VERSION, type ExecutionResult } from "./types";

// The only place ExecutionLog gets written. Append-only, by convention: this
// file only ever calls .create() — never .update() — so a logical request's
// status changing over time (e.g. PENDING -> SUCCESS) always becomes a new
// row sharing `executionId`, never a mutated one. See ARCHITECTURE.md.
//
// Returns the created row's real id — Growth Points Economy (Chapter 2)
// needs it to link a DEDUCTION GrowthPointTransaction back to the exact
// ExecutionLog row it paid for (lib/execution/engine.ts).
export async function recordExecution<TMetadata>(
  result: ExecutionResult<TMetadata>,
  // WHICH CLIENT TO WRITE ON, when the caller is already inside a transaction.
  //
  // Added 2026-08-23 for proactive delivery, which must write an execution row,
  // a message and a delivery claim as one unit — a conflict on the claim has to
  // take the message with it, or the owner sees a finding twice. Defaults to the
  // ordinary client, so every existing caller is unchanged.
  client: Pick<typeof prisma, "executionLog"> = prisma
): Promise<{ id: string }> {
  return client.executionLog.create({
    data: {
      executionId: result.executionId,
      // The ambient chain, so an execution triggered by a request joins that
      // request's story rather than starting a second one. Null outside any
      // scope — a script or a test has no chain to join, and inventing one
      // would be a causal claim nobody made.
      correlationId: correlationId(),
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
    select: { id: true },
  });
}
