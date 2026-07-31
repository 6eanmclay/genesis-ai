import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import { getStoreRole, hasPermission } from "@/lib/permissions";
import { execute } from "./engine";
import { GENESIS_ACTIONS, type GenesisActionContext, type BlueprintContextSubset } from "./genesisActions";
import type { Theme } from "@/lib/theme";

// Phase 6 — the one place that decides "may Genesis handle this without
// asking" and, if so, does it. This is a second CODE PATH, not a second
// Genesis: same GENESIS_ACTIONS registry, same execute() engine, same
// ApprovalRequest/ExecutionLog lineage, same actorType "GENESIS" — the only
// difference from the human path is who decided and when. Genesis's own
// judgment (did Claude think this was a good idea) is computed entirely
// upstream of this file and is never re-examined here; this file only
// answers a narrow, deterministic question: does the owner's own granted
// authority cover this specific action, right now.
//
// Deliberately callable ONLY from the proactive review engine
// (generateGenesisRecommendations.ts) — never from chat. If the owner is
// actively chatting with Genesis right now, they're already present and
// should see that turn's proposal in-conversation, never have it silently
// auto-applied behind their back.

// Returns the active grant for (storeId, actionType), or null if none
// exists or it has been revoked. A cheap, indexed read.
async function getActiveDelegatedAuthority(storeId: string, actionType: string) {
  return prisma.delegatedAuthority.findFirst({
    where: { storeId, actionType, revokedAt: null },
  });
}

// Phase 3 Milestone 6 — gained an optional `record` param, populating the
// new businessRecord context field for the record-scoped operations
// actions (update_goal_status/resolve_challenge), the same way `product`
// already gets populated for update_product_image elsewhere in this
// codebase — just resolved here instead, since this is the one place that
// builds context for the autonomous-execution path specifically.
async function buildActionContext(
  storeId: string,
  record?: { id: string; entityType: string } | null
): Promise<GenesisActionContext> {
  const [store, businessRecord] = await Promise.all([
    prisma.store.findUniqueOrThrow({
      where: { id: storeId },
      select: { name: true, tagline: true, description: true, theme: true, blueprint: true },
    }),
    record
      ? prisma.businessRecord.findFirst({
          where: { id: record.id, storeId, entityType: record.entityType },
          select: { id: true, entityType: true, data: true },
        })
      : Promise.resolve(null),
  ]);
  return {
    blueprint: store.blueprint as BlueprintContextSubset | null,
    theme: store.theme as Theme | null,
    storeIdentity: { name: store.name, tagline: store.tagline, description: store.description },
    businessRecord: businessRecord
      ? { id: businessRecord.id, entityType: businessRecord.entityType, data: businessRecord.data }
      : null,
  };
}

interface TryExecuteAutonomousActionParams {
  storeId: string;
  actionType: string;
  input: unknown;
  summary: string;
  topicKey: string;
  // Phase 3 Milestone 6 — the Cognitive Layer's own CognitiveOutput id,
  // replacing the legacy recommendationId (GeneratedRecommendation is no
  // longer written to going forward — see cognitiveLayer.ts). recordId/
  // entityType are new, optional — set only when the proposing output was
  // genuinely about one specific BusinessRecord (a Goal, a Challenge...),
  // letting this function resolve that record into context.businessRecord.
  cognitiveOutputId: string | null;
  recordId?: string | null;
  entityType?: string | null;
  groupId: string;
}

// Self-contained and safe to call speculatively for every proposedAction a
// review produces — performs every eligibility check itself rather than
// trusting a caller to have already done so, and simply declines (returns
// false) if any of them don't hold. The caller's only job on `false` is to
// fall back to the existing PENDING_APPROVAL flow, unchanged.
export async function tryExecuteAutonomousAction(
  params: TryExecuteAutonomousActionParams
): Promise<boolean> {
  const { storeId, actionType, input, summary, topicKey, cognitiveOutputId, recordId, entityType, groupId } = params;

  const definition = GENESIS_ACTIONS[actionType];
  if (!definition || definition.maxAuthorityTier === "always_ask") {
    // Not a delegable action type at all — the concept of authority doesn't
    // exist for it, regardless of anything else.
    return false;
  }

  const grant = await getActiveDelegatedAuthority(storeId, actionType);
  if (!grant) return false;

  // Re-derive the store's owner and confirm the account itself still holds
  // whatever permission the underlying Executable requires — delegated
  // authority can never let Genesis do something even the human owner isn't
  // permitted to do. Cheap and, today, always true (OWNER holds every
  // permission) — kept as a real check, not a formality, so a future change
  // to what "owner" can do would correctly constrain this too.
  const store = await prisma.store.findUnique({ where: { id: storeId }, select: { userId: true } });
  if (!store) return false;
  const role = await getStoreRole(store.userId, storeId);
  if (!role || (definition.executable.requiredPermission && !hasPermission(role, definition.executable.requiredPermission))) {
    return false;
  }

  const parsedInput = definition.inputSchema.safeParse(input);
  if (!parsedInput.success) return false;

  const context = await buildActionContext(
    storeId,
    recordId && entityType ? { id: recordId, entityType } : null
  );
  const previousValues = definition.getCurrentValues(context);

  // Same supersede convention every other proposal-creation path already
  // uses — avoid piling up a stale PENDING_APPROVAL row for the same
  // actionType underneath a fresh autonomous decision.
  await prisma.approvalRequest.deleteMany({
    where: { storeId, actionType, status: "PENDING_APPROVAL" },
  });

  const approval = await prisma.approvalRequest.create({
    data: {
      storeId,
      cognitiveOutputId,
      actionType,
      input: parsedInput.data as object,
      previousValues: previousValues as object,
      summary,
      authorizationTier: "auto",
      groupId,
      topicKey,
      decisionMode: "autonomous",
      delegatedAuthorityId: grant.id,
    },
  });

  const result = await execute(definition.executable, parsedInput.data, {
    storeId,
    actorType: "GENESIS",
    preAuthorizedGrantId: grant.id,
  });

  if (result.status === "FAILED") {
    // Same escalation the human FAILED-revert path already uses: never
    // retried automatically, surfaces as a real PENDING_APPROVAL a human
    // can see and decide on, executionId set so it reads as "Genesis tried
    // this and it failed," not "never acted on."
    await prisma.approvalRequest.update({
      where: { id: approval.id },
      data: { executionId: result.executionId },
    });
    // Phase 3 Milestone 6 — either way an ApprovalRequest now exists for
    // this output (pending-after-failure or executed below), so it stops
    // also showing in the recommendations list — same rule the human
    // approval path already follows (genesisProducer excludes anything
    // with a live approval), just applied on the write side here.
    if (cognitiveOutputId) {
      await prisma.cognitiveOutput.update({
        where: { id: cognitiveOutputId },
        data: { status: "SUPERSEDED", approvalRequestId: approval.id },
      });
    }
    return true; // handled (declined to silently retry) -- caller must not also create a normal PENDING row
  }

  await prisma.approvalRequest.update({
    where: { id: approval.id },
    data: {
      status: "EXECUTED",
      executionId: result.executionId,
      decidedAt: new Date(),
    },
  });

  if (cognitiveOutputId) {
    // Durable, unlike the old GeneratedRecommendation.deleteMany this
    // replaces — CognitiveOutput is meant to be queryable history (see
    // getEntityHistory), so a resolved output is marked, never deleted.
    await prisma.cognitiveOutput.update({
      where: { id: cognitiveOutputId },
      data: { status: "RESOLVED", approvalRequestId: approval.id, resolvedAt: new Date() },
    });
  }

  return true;
}

// --- Grant / revoke — always OWNER-only, enforced by the caller via
// PERMISSIONS.AUTHORITY_MANAGE (see app/dashboard/actions.ts). These two
// functions assume that check already happened; they don't re-check
// permission themselves so they can also be reused directly in scripts/
// tests without a request context, same convention as the rest of this
// module.

export async function grantDelegatedAuthority(params: {
  storeId: string;
  actionType: string;
  grantedByUserId: string;
}): Promise<void> {
  const definition = GENESIS_ACTIONS[params.actionType];
  if (!definition || definition.maxAuthorityTier === "always_ask") {
    throw new Error(`"${params.actionType}" cannot be delegated — it has no maxAuthorityTier above always_ask.`);
  }
  await prisma.delegatedAuthority.upsert({
    where: { storeId_actionType: { storeId: params.storeId, actionType: params.actionType } },
    create: {
      id: randomUUID(),
      storeId: params.storeId,
      actionType: params.actionType,
      grantedByUserId: params.grantedByUserId,
    },
    // Re-granting after a prior revoke reactivates the same row rather than
    // spawning a duplicate — one row per (store, actionType), always.
    update: { revokedAt: null, grantedAt: new Date(), grantedByUserId: params.grantedByUserId },
  });
}

export async function revokeDelegatedAuthority(storeId: string, actionType: string): Promise<void> {
  await prisma.delegatedAuthority.updateMany({
    where: { storeId, actionType, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
