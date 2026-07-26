import { randomUUID } from "crypto";
import { unstable_rethrow } from "next/navigation";
import { requireStorePermission } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import type { Executable, ExecutionContext } from "./executable";
import { GENESIS_ACTIONS } from "./genesisActions";
import { CURRENT_EXECUTION_SCHEMA_VERSION, type ActorType, type ExecutionResult, type ExecutionStatus } from "./types";
import { recordExecution } from "./log";

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
    await recordExecution(result);
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
