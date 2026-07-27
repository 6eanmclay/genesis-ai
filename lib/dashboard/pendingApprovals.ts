import { prisma } from "@/lib/prisma";

export interface PendingApproval {
  id: string;
  summary: string;
  actionType: string;
  input: Record<string, unknown>;
  previousValues: Record<string, unknown>;
  createdAt: Date;
  // Phase 4 — shared across every ApprovalRequest created from one Genesis
  // "thought." Null for anything created before this shipped, or for a
  // single, ungrouped proposal — always fall back to the row's own id when
  // clustering (see website/page.tsx), never assume it's set.
  groupId: string | null;
  // Non-null only when Genesis already tried to apply this exact proposal
  // and it failed (approveGenesisAction reverts the row to
  // PENDING_APPROVAL on FAILED instead of clearing it) — a fresh,
  // never-acted-on proposal always has this null. lastFailureMessage is the
  // linked ExecutionLog row's message, looked up below, so the UI can show
  // what actually went wrong rather than just "something failed."
  lastFailedExecutionId: string | null;
  lastFailureMessage: string | null;
  // Phase 5 field, exposed here for the contextual-review connection layer
  // (deep-linking + Genesis's auto-opened context message) — lets a caller
  // join back to a GenesisObservation's summary without a new query.
  topicKey: string | null;
}

// Cheap indexed DB read, not an AI call — safe on every dashboard load,
// same reasoning as genesisProducer. Oldest first, so the longest-waiting
// decision surfaces first.
export async function getPendingApprovals(storeId: string): Promise<PendingApproval[]> {
  const rows = await prisma.approvalRequest.findMany({
    where: { storeId, status: "PENDING_APPROVAL" },
    orderBy: { createdAt: "asc" },
  });

  const failedExecutionIds = rows
    .map((row) => row.executionId)
    .filter((id): id is string => id !== null);
  const failureLogs = failedExecutionIds.length
    ? await prisma.executionLog.findMany({
        where: { executionId: { in: failedExecutionIds }, status: "FAILED" },
        select: { executionId: true, message: true },
      })
    : [];
  const failureMessageByExecutionId = new Map(failureLogs.map((log) => [log.executionId, log.message]));

  return rows.map((row) => ({
    id: row.id,
    summary: row.summary,
    actionType: row.actionType,
    input: row.input as Record<string, unknown>,
    previousValues: row.previousValues as Record<string, unknown>,
    createdAt: row.createdAt,
    groupId: row.groupId,
    // executionId is only ever set on a still-PENDING_APPROVAL row by the
    // failure-revert path in approveGenesisAction — a fresh, never-acted-on
    // proposal always has it null.
    lastFailedExecutionId: row.executionId,
    lastFailureMessage: row.executionId ? failureMessageByExecutionId.get(row.executionId) ?? null : null,
    topicKey: row.topicKey,
  }));
}

// Shared by every path that creates a new proposal for an action type a
// store can only have one pending decision for at a time (chat's
// update_product_image detection, the new Phase 1 chat-driven actions, and
// generateGenesisRecommendations.ts) — a fresh proposal always supersedes
// whatever was still awaiting a decision, rather than stacking up multiple
// pending rows for the same actionType.
export async function supersedePendingApproval(
  storeId: string,
  actionType: string,
  extraWhere: Record<string, unknown> = {}
): Promise<void> {
  await prisma.approvalRequest.deleteMany({
    where: { storeId, actionType, status: "PENDING_APPROVAL", ...extraWhere },
  });
}
