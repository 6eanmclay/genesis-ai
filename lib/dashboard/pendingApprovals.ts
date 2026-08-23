import { recoverStuckApprovals } from "./approvalRecovery";
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
  // RECOVERY RUNS HERE (D4, 2026-08-23), before the read rather than on a
  // schedule. An approval whose execution was claimed and never resolved is
  // invisible to the query below — it is EXECUTING, not PENDING_APPROVAL — so
  // the moment somebody looks at the list a stuck row would be missing from is
  // exactly the moment worth reconciling it.
  //
  // No scheduler and no new entry point. It reads evidence, never elapsed time,
  // and settles an attempt that provably finished rather than retrying it —
  // see lib/dashboard/approvalRecovery.ts.
  await recoverStuckApprovals(storeId);

  const rows = await prisma.approvalRequest.findMany({
    where: { storeId, status: "PENDING_APPROVAL" },
    orderBy: { createdAt: "asc" },
  });

  const failedExecutionIds = rows
    .map((row) => row.executionId)
    .filter((id): id is string => id !== null);
  const failureLogs = failedExecutionIds.length
    ? await prisma.executionLog.findMany({
        where: { storeId, executionId: { in: failedExecutionIds }, status: "FAILED" },
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

// J4 conversational approval (2026-08-09) — "when I tell J4 'approve all'
// or 'take care of everything,' that's authorization for the group of
// changes it just presented, not a new request to re-analyze" (Sean). The
// only honest way to resolve "the group it just presented" without asking
// the model to guess or hallucinate a groupId is the most recently created
// still-pending ApprovalRequest — in a real, linear conversation that IS
// whatever J4 last proposed. If it carries a groupId, every other member of
// that same batch comes along too (the conversational analogue of the
// "Approve All N" button); an ungrouped proposal resolves to just itself.
export interface PendingApprovalBatch {
  groupId: string | null;
  approvalIds: string[];
  summaries: string[];
}

export async function resolveMostRecentPendingApprovalBatch(storeId: string): Promise<PendingApprovalBatch | null> {
  const mostRecent = await prisma.approvalRequest.findFirst({
    where: { storeId, status: "PENDING_APPROVAL" },
    orderBy: { createdAt: "desc" },
  });
  if (!mostRecent) return null;

  if (!mostRecent.groupId) {
    return { groupId: null, approvalIds: [mostRecent.id], summaries: [mostRecent.summary] };
  }

  const members = await prisma.approvalRequest.findMany({
    where: { storeId, groupId: mostRecent.groupId, status: "PENDING_APPROVAL" },
    orderBy: { createdAt: "asc" },
  });
  return { groupId: mostRecent.groupId, approvalIds: members.map((m) => m.id), summaries: members.map((m) => m.summary) };
}

// J4 conversational approval (2026-08-09) — plain, non-"use server" home for
// the batch-approval result shape and its two deterministic phrasings
// (ai-actions.ts's own exports can only be async functions, so these — and
// GroupApprovalResult itself — live here instead, imported by both
// ai-actions.ts's perform*/approveGenesisActionGroup and route.ts's
// approve_pending_changes handler).
export interface GroupApprovalResult {
  totalMembers: number;
  succeeded: string[];
  // "If one fails, tell me exactly which change failed and why" (Sean). The
  // button's own describeGroupApprovalResult only ever needed a count; the
  // chat reply needs the real per-item reason, so this carries both rather
  // than a caller having to re-derive "why" from nothing.
  failed: { summary: string; reason: string }[];
}

// One honest, human-readable outcome for a batch approval — the manual
// "Approve All" button's own StoreMessage.
export function describeGroupApprovalResult(result: GroupApprovalResult): string {
  return result.failed.length === 0
    ? `Applied all ${result.succeeded.length} change${result.succeeded.length === 1 ? "" : "s"} from that idea.`
    : result.succeeded.length === 0
      ? `Couldn't apply ${result.failed.length === 1 ? "that change" : `any of the ${result.failed.length} changes`} — still pending, so you can retry from the review page.`
      : `Applied ${result.succeeded.length} of ${result.totalMembers} — ${result.failed.length} couldn't be applied and ${result.failed.length === 1 ? "is" : "are"} still pending so you can retry.`;
}

// "Done. I applied all 4 changes and verified them." / "3 of 4 completed.
// One needs attention: [specific failure]." (Sean's own exact desired
// phrasing). Deterministic, not model-generated — same discipline
// manage_business_asset's own reply already follows, since "I applied and
// verified this" is exactly the kind of claim that must be airtight, never
// something the model could get subtly wrong. Shared by both
// approve_pending_changes call sites (app/api/chat/route.ts and
// applyGenesisMessageToStore) so the report reads identically regardless of
// which path handled the turn.
export function describeApprovalExecutionForChat(result: GroupApprovalResult): string {
  if (result.totalMembers === 0) {
    return "There's nothing pending for me to approve right now.";
  }
  if (result.failed.length === 0) {
    return result.succeeded.length === 1
      ? "Done. I applied that change and verified it."
      : `Done. I applied all ${result.succeeded.length} changes and verified them.`;
  }
  const failureList = result.failed.map((f) => `${f.summary} — ${f.reason}`).join("; ");
  if (result.succeeded.length === 0) {
    return result.totalMembers === 1
      ? `That didn't go through: ${failureList}. It's still pending, so we can retry.`
      : `None of the ${result.totalMembers} changes went through: ${failureList}. They're still pending, so we can retry.`;
  }
  return `${result.succeeded.length} of ${result.totalMembers} completed. ${result.failed.length === 1 ? "One needs" : `${result.failed.length} need`} attention: ${failureList}.`;
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
