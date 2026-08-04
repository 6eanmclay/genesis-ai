import { randomUUID } from "crypto";
import { unstable_rethrow } from "next/navigation";
import { requireStorePermission } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import type { Executable, ExecutionContext } from "./executable";
import { GENESIS_ACTIONS, type GenesisActionType } from "./genesisActions";
import { CURRENT_EXECUTION_SCHEMA_VERSION, type ActorType, type ExecutionResult, type ExecutionStatus } from "./types";
import { recordExecution } from "./log";
import { checkGrowthPointBalance, deductGrowthPoints } from "@/lib/growthPoints/ledger";

interface ExecuteOptions {
  storeId?: string;
  actorType?: ActorType;
  // Pass the executionId of a prior PENDING row to record this call as its
  // resolution (same logical request) rather than starting a new one.
  executionId?: string;
  // Phase 6 — the ONLY way to skip requireStorePermission's human-session
  // requirement. NOT a claim to be trusted: execute() independently
  // re-fetches this exact DelegatedAuthority row and verifies it is active
  // AND matches the executable actually being run (actionType) before using
  // it for anything. storeId/userId for the resulting ExecutionContext are
  // derived entirely from that live row, never from opts.storeId or any
  // other caller-supplied value — a caller cannot claim authorization for
  // one store/action while supplying a grant that covers a different one.
  // The only legitimate caller is lib/execution/genesisAutonomy.ts, which
  // performs its own full DelegatedAuthority + owner-permission + action-
  // eligibility checks BEFORE ever reaching this option — this field's own
  // re-check is deliberately narrow (does this grant genuinely exist, is it
  // active, does it match this exact action), not a re-derivation of
  // everything the caller already verified.
  preAuthorizedGrantId?: string;
  // Phase 3 Milestone 3 (Business Intelligence Engine) — the scheduler's
  // own bypass, mirroring preAuthorizedGrantId's shape: the ONLY other way
  // to skip requireStorePermission's human-session requirement. Unlike
  // preAuthorizedGrantId there is no grant row to re-verify — this is a
  // deliberately narrow, unconditional bypass, so it carries a real, new
  // trust boundary of its own: this is the first path in this codebase
  // that can execute with genuinely zero human/request context (every
  // "autonomous" execution before this still rode a real request via
  // after()). The only legitimate caller is lib/intelligence/scheduler.ts,
  // itself only ever invoked from the CRON_SECRET-gated cron route — never
  // reachable from any browser-facing code path. ctx.actorType is always
  // forced to "SYSTEM" regardless of opts.actorType, exactly like the
  // existing requiredPermission-null branch below already does.
  systemStoreId?: string;
  // J4 Foundation Phase 1 (Execute Hardening) — the third and narrowest way
  // to skip requireStorePermission's human-session requirement. Unlike
  // preAuthorizedGrantId there is no DelegatedAuthority row to re-verify:
  // this path exists specifically for a mechanic the registry itself marks
  // authorityExempt (see genesisActions.ts's own doc comment on that field)
  // — one whose run() has zero effect beyond recording what's being
  // communicated. execute() independently re-verifies the named actionType
  // really resolves to this exact executable AND really carries
  // authorityExempt: true before using it for anything; a caller cannot
  // skip a grant check for an ordinary action just by naming it here.
  // actorType is always forced to "GENESIS" — this is Genesis's own act,
  // never an unattended scheduler tick (systemStoreId's job) and never
  // something a delegated grant was needed for (preAuthorizedGrantId's
  // job). The only legitimate caller is communicateFinding() in
  // lib/execution/genesisAutonomy.ts.
  authorityExemptAction?: { storeId: string; actionType: string };
  // Growth Points Economy (Chapter 2) — set only by callers dispatching a
  // real GENESIS_ACTIONS entry (the approval path, batch approval,
  // autonomous delegated-authority execution): the real catalog key
  // (lib/growthPoints/catalog.ts) execute() checks a cost against and, on
  // success, debits. Deliberately NOT set by direct executable.run() paths
  // that never go through the registry (the scheduler's own syncs,
  // communicateFinding's purely-additive findings, a manual owner revert) —
  // those stay free, exactly matching "thinking is free, only real
  // GENESIS_ACTIONS work Genesis performs for the business is invested."
  actionType?: GenesisActionType;
}

function buildResult<TMetadata>(
  partial: Omit<ExecutionResult<TMetadata>, "timestamp" | "schemaVersion">
): ExecutionResult<TMetadata> {
  return {
    ...partial,
    schemaVersion: CURRENT_EXECUTION_SCHEMA_VERSION,
    timestamp: new Date(),
  };
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong";
}

// The single place every retrofitted action's outcome flows through: runs
// the executable, builds a standardized ExecutionResult, persists one new
// ExecutionLog row (append-only — see lib/execution/log.ts), and returns
// the result. Any thrown error at any step becomes a FAILED result instead
// of crashing to Next's raw error boundary.
export async function execute<TInput, TMetadata>(
  executable: Executable<TInput, TMetadata>,
  input: TInput,
  opts: ExecuteOptions = {}
): Promise<ExecutionResult<TMetadata>> {
  const executionId = opts.executionId ?? randomUUID();
  const actorType: ActorType = opts.actorType ?? "USER";

  let ctx: ExecutionContext;
  try {
    if (opts.preAuthorizedGrantId) {
      // Independent re-verification, not trust in the caller's say-so — see
      // the field's own doc comment above.
      const grant = await prisma.delegatedAuthority.findUnique({
        where: { id: opts.preAuthorizedGrantId },
      });
      // Object-identity check against the canonical registry mapping, not a
      // string comparison — grant.actionType is a GENESIS_ACTIONS key (e.g.
      // "update_seo"), which is a different namespace from the executable's
      // own `.action` (e.g. "store.update_seo", used for ExecutionLog).
      // Resolving through GENESIS_ACTIONS[grant.actionType].executable and
      // comparing it to the exact executable being run is immune to that
      // naming mismatch and can't be fooled by a caller separately
      // asserting an actionType string that doesn't really describe what's
      // being executed.
      const registeredExecutable = grant ? GENESIS_ACTIONS[grant.actionType]?.executable : undefined;
      if (!grant || grant.revokedAt || registeredExecutable !== executable) {
        throw new Error(
          "Delegated authority is missing, revoked, or does not match this action"
        );
      }
      ctx = { storeId: grant.storeId, userId: null, actorType };
    } else if (opts.systemStoreId) {
      ctx = { storeId: opts.systemStoreId, userId: null, actorType: "SYSTEM" };
    } else if (opts.authorityExemptAction) {
      const def = GENESIS_ACTIONS[opts.authorityExemptAction.actionType];
      if (!def || def.executable !== executable || !def.authorityExempt) {
        throw new Error(
          `"${opts.authorityExemptAction.actionType}" is not registered as authority-exempt`
        );
      }
      ctx = { storeId: opts.authorityExemptAction.storeId, userId: null, actorType: "GENESIS" };
    } else if (executable.requiredPermission) {
      const { userId, storeId } = await requireStorePermission(
        executable.requiredPermission,
        opts.storeId
      );
      ctx = { storeId, userId, actorType };
    } else {
      if (!opts.storeId) {
        throw new Error("storeId is required when requiredPermission is null");
      }
      ctx = { storeId: opts.storeId, userId: null, actorType: "SYSTEM" };
    }
  } catch (error) {
    // requireStorePermission's own redirect("/login") throws a special
    // Next.js error that must propagate, not get swallowed into a result.
    unstable_rethrow(error);

    const result = buildResult<TMetadata>({
      executionId,
      action: executable.action,
      status: "FAILED",
      verified: false,
      message: messageFromError(error),
      retryable: false,
      actorType,
      actorId: null,
      storeId: opts.storeId ?? null,
      storeDraftId: null,
      metadata: {} as TMetadata,
    });
    await recordExecution(result);
    return result;
  }

  // Growth Points Economy (Chapter 2) — a read-only gate, checked before any
  // real work happens. Only engages when the caller passed a real
  // GenesisActionType (see ExecuteOptions.actionType's own doc comment);
  // growthPointCost stays null (free, matching every "honest null" catalog
  // in this codebase) for every unpriced action, which today is all of
  // them — the catalog is deliberately empty until Sean assigns real values.
  let growthPointCost: number | null = null;
  if (opts.actionType) {
    const gate = await checkGrowthPointBalance(ctx.storeId, opts.actionType);
    growthPointCost = gate.cost;
    if (!gate.ok) {
      const result = buildResult<TMetadata>({
        executionId,
        action: executable.action,
        status: "FAILED",
        verified: false,
        message: "This would need more Growth Points than you currently have to invest.",
        retryable: false,
        actorType: ctx.actorType,
        actorId: ctx.userId,
        storeId: ctx.storeId,
        storeDraftId: null,
        metadata: {} as TMetadata,
      });
      await recordExecution(result);
      return result;
    }
  }

  try {
    const outcome = await executable.run(input, ctx);
    let verified = false;
    let status: ExecutionStatus = outcome.partial
      ? "PARTIAL"
      : (outcome.redirectUrl || outcome.pending)
        ? "PENDING"
        : "SUCCESS";

    if (executable.verify) {
      const v = await executable.verify(input, ctx);
      verified = v.ok;
      if (!v.ok) status = "WARNING";
    }

    const result = buildResult<TMetadata>({
      executionId,
      action: executable.action,
      status,
      verified,
      message: outcome.message,
      retryable: outcome.retryable ?? false,
      redirectUrl: outcome.redirectUrl,
      actorType: ctx.actorType,
      actorId: ctx.userId,
      storeId: ctx.storeId,
      storeDraftId: null,
      metadata: (outcome.metadata ?? {}) as TMetadata,
    });
    const logRow = await recordExecution(result);
    // Only reachable here on a real (non-FAILED) outcome — a thrown error
    // is caught below instead, so a failed attempt never costs the owner
    // real points.
    if (growthPointCost !== null && opts.actionType) {
      await deductGrowthPoints({
        storeId: ctx.storeId,
        actionType: opts.actionType,
        cost: growthPointCost,
        executionLogId: logRow.id,
      });
    }
    return result;
  } catch (error) {
    unstable_rethrow(error);

    const result = buildResult<TMetadata>({
      executionId,
      action: executable.action,
      status: "FAILED",
      verified: false,
      message: messageFromError(error),
      retryable: false,
      actorType: ctx.actorType,
      actorId: ctx.userId,
      storeId: ctx.storeId,
      storeDraftId: null,
      metadata: {} as TMetadata,
    });
    await recordExecution(result);
    return result;
  }
}
