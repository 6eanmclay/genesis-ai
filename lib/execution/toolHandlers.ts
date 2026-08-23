import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import { persistSyncedRecords } from "@/lib/businessModel/sync";
import { ENTITY_REGISTRY } from "@/lib/businessModel/entities";
import { toGoalRecordData, toChallengeRecordData } from "@/lib/businessModel/factCapture";
import { UPLOAD_INTENT_REPLY } from "@/lib/dashboard/storeChatUnified";
import type { BusinessFactCaptureInput } from "@/lib/execution/genesisTools";

// WHAT A TOOL ACTUALLY DOES, SEPARATED FROM HOW THE TURN ENDS
// (2026-08-22, Unified Intelligence UI3).
//
// THE PROBLEM THIS STARTS SOLVING. Every tool branch lives inline in
// app/api/chat/route.ts — nineteen of them, ~1,600 lines — and each one ends by
// writing messages, emitting, logging the turn and closing the stream itself.
// Two consequences, and the second is the one that made this worth doing.
//
// FIRST, they cannot compose. A branch that closes the controller is the last
// thing that happens, so a turn is structurally limited to one tool no matter
// what the model asked for.
//
// SECOND, AND WORSE: they have no test coverage at all, because the only way to
// reach one is through a model. approve_pending_changes EXECUTES approved
// changes to a live store and has never had a test. That is not a structural
// complaint; it is real money-adjacent code nobody can check.
//
// A handler here takes a context and RETURNS what it did. It writes no chat
// message, emits nothing, closes nothing, and logs no turn — the caller owns all
// of that, once, however many handlers ran. Which is what makes a handler
// callable from a suite with a real database and no model at all.
//
// MIGRATED INCREMENTALLY, ON PURPOSE. Three branches live here today; the rest
// still run inline exactly as before, and the dispatcher falls through to them
// untouched. Moving nineteen bespoke branches in one pass, with no coverage to
// catch a mistake, is how a working product breaks quietly. Each one that moves
// gains a test on the way.

export interface ToolTurnContext {
  storeId: string;
  /** The authenticated viewer. Authorization already happened; this is for attribution. */
  userId: string;
  userMessage: string;
  /**
   * The model's own accompanying text, if it wrote any.
   *
   * Handlers prefer it over their own wording where the model knows something
   * they do not — it read the actual message. Where a claim must be airtight,
   * they use a fixed string instead and say so.
   */
  conversationalReply: string;
  /** The tool's raw input, exactly as the model emitted it. Never pre-validated. */
  input: unknown;
  /** A progress line for the owner while real work happens. */
  status: (text: string) => void;
}

export type ToolTurnResult =
  | {
      handled: true;
      /** What to say. Never empty — a turn that did something must say so. */
      reply: string;
      /** For the execution log, so a turn is identifiable afterwards. */
      kind: string;
      metadata?: Record<string, unknown>;
    }
  | {
      /**
       * The handler could not make sense of what it was given.
       *
       * Distinct from failing: nothing was written, and the caller should fall
       * back rather than report a result. Used where the model's input does not
       * validate — confirming a capture that never happened would be worse than
       * an honest fallback.
       */
      handled: false;
      reason: "invalid_input";
    };

export type ToolHandler = (ctx: ToolTurnContext) => Promise<ToolTurnResult>;

/**
 * Point the owner at the upload controls.
 *
 * Was an entire model round trip on every message until 2026-08-22, then a tool,
 * and now a handler. It reads nothing and writes nothing.
 */
const showUploadOptions: ToolHandler = async (ctx) => ({
  handled: true,
  // The model's own words when it wrote any — it knows what was actually said.
  // The standing reply is a floor, not a preference.
  reply: ctx.conversationalReply || UPLOAD_INTENT_REPLY,
  kind: "upload_intent",
});

/**
 * Remember something durable the owner said about their business.
 *
 * The provenance pair here is the whole reason this is not a one-liner: OWNER
 * because the owner is the author — nobody else can say what they are trying to
 * do — and modelExtracted TRUE because the sentence stored is a model's reading
 * of what they typed, not their words. A reader that saw only OWNER would quote
 * a paraphrase back as though they had said it.
 */
const captureBusinessFact: ToolHandler = async (ctx) => {
  ctx.status("Got it — recording that…");

  const input = ctx.input as BusinessFactCaptureInput;
  const entityType = input?.entityType;
  const todayIso = new Date().toISOString().slice(0, 10);

  // AN UNKNOWN entityType IS A MISS, NOT A CRASH. `input` is whatever the model
  // emitted, so a bare ENTITY_REGISTRY[entityType] throws on anything outside
  // the enum and takes the whole turn down. Object.hasOwn, not `in`, for the
  // reason ARCHITECTURE.md's sibling rule gives: a prototype key is not an
  // entity type.
  const registryEntry =
    typeof entityType === "string" && Object.hasOwn(ENTITY_REGISTRY, entityType)
      ? ENTITY_REGISTRY[entityType as keyof typeof ENTITY_REGISTRY]
      : null;
  // BELT AND BRACES on an untrusted key. Object.hasOwn already closes the
  // lookup; this also survives a registry entry that somehow has no schema, so
  // a bad tool input can never become a TypeError that takes the turn down.
  if (!registryEntry || typeof registryEntry.schema?.safeParse !== "function") {
    return { handled: false, reason: "invalid_input" };
  }

  const fullData =
    entityType === "goal"
      ? toGoalRecordData(input.data, todayIso)
      : entityType === "challenge"
        ? toChallengeRecordData(input.data, todayIso)
        : entityType === "employee"
          ? { ...input.data, status: "active", locationId: null }
          : input.data;

  const parsed = registryEntry.schema.safeParse(fullData);
  // Confirming a capture that never happened is worse than falling back.
  if (!parsed.success) return { handled: false, reason: "invalid_input" };

  const { changes } = await persistSyncedRecords(
    ctx.storeId,
    "genesis_chat",
    [{ entityType, externalId: randomUUID(), data: parsed.data }],
    {
      provenance: "OWNER",
      provenanceDetail: "chat",
      statedById: ctx.userId,
      modelExtracted: true,
    }
  );

  // A HIGH-SEVERITY, ACTIVE CHALLENGE BECOMES SOMETHING J4 IS WATCHING, through
  // the Business Intelligence Engine's own existing mechanisms rather than a
  // second notification system. Imported lazily for the same reason the inline
  // branch did: this path runs on an ordinary chat turn and should not pay for
  // the autonomy layer on every message that is not a challenge.
  if (entityType === "challenge" && changes[0]) {
    const challengeData = parsed.data as { severity: string | null; status: string; description: string };
    const recordId = changes[0].recordId;
    const topicKey = `challenge:${recordId}`;

    if (challengeData.severity === "high" && challengeData.status === "active") {
      const alreadyActive = await prisma.cognitiveOutput.findFirst({
        where: { storeId: ctx.storeId, topicKey, status: "ACTIVE" },
        select: { id: true },
      });
      const { communicateFinding } = await import("@/lib/execution/genesisAutonomy");
      const { upsertObservation } = await import("@/lib/dashboard/genesisObservations");
      if (!alreadyActive) {
        await communicateFinding(ctx.storeId, {
          kind: "insight",
          summary: challengeData.description,
          priority: "high",
          topicKey,
          recordId,
          entityType: "challenge",
        });
      }
      await upsertObservation(ctx.storeId, {
        dedupeKey: topicKey,
        genesisState: "urgent",
        summary: challengeData.description,
        actionHref: null,
        recordId,
        entityType: "challenge",
      });
    } else {
      // Downgraded or resolved: stop watching it, rather than leaving a stale
      // urgent card the owner has to dismiss.
      const { resolveMissingObservations } = await import("@/lib/dashboard/genesisObservations");
      await resolveMissingObservations(ctx.storeId, [], "urgent", topicKey);
      await prisma.cognitiveOutput.updateMany({
        where: { storeId: ctx.storeId, topicKey, status: "ACTIVE" },
        data: { status: "RESOLVED", resolvedAt: new Date() },
      });
    }
  }

  return {
    handled: true,
    reply: ctx.conversationalReply || "Got it — I'll remember that about your business.",
    kind: "business_fact",
    metadata: { entityType },
  };
};

/**
 * Execute changes the owner already approved.
 *
 * The one handler here that moves real state on a live store, and — until this
 * file — the one with no test of any kind, because the only way to reach it was
 * through a model.
 *
 * `execute` is injected so a suite can drive every branch including the failure
 * ones. Defaulted to the real implementation, which is imported lazily: it lives
 * in a "use server" module, and pulling that into every consumer of this file at
 * load time would drag the whole action surface with it.
 */
export function makeApprovePendingChanges(
  execute?: (storeId: string) => Promise<{ ok: boolean; summary: string }>
): ToolHandler {
  return async (ctx) => {
    ctx.status("Applying the approved changes…");
    try {
      if (execute) {
        const result = await execute(ctx.storeId);
        return { handled: true, reply: result.summary, kind: "approve_pending_changes" };
      }
      const { performApprovePendingChanges } = await import("@/app/dashboard/ai-actions");
      const { describeApprovalExecutionForChat } = await import("@/lib/dashboard/pendingApprovals");
      const result = await performApprovePendingChanges(ctx.storeId);
      return {
        handled: true,
        reply: describeApprovalExecutionForChat(result),
        kind: "approve_pending_changes",
      };
    } catch (err) {
      // requireStorePermission inside the perform* functions throws a plain
      // Error for a real insufficient-permission case. ANALYTICS_VIEW is
      // stricter than the tool's own store:manage, so a member who passed the
      // tool check can still legitimately land here — and the honest decline is
      // better than a generic failure.
      //
      // NOTHING WAS APPLIED IN EITHER BRANCH, and both replies say so. A turn
      // that reported success on a throw would be the exact failure the standing
      // rule against claiming a change that did not happen exists to prevent.
      return {
        handled: true,
        reply:
          err instanceof Error && err.message.includes("permission")
            ? "Approving changes is something only the store owner can do — ask them to approve this, or to give you broader access."
            : "Something went wrong applying those changes — they're still pending, so you can retry from the review page.",
        kind: "approve_pending_changes",
      };
    }
  };
}

/**
 * The tools that have moved out of the inline ladder.
 *
 * A hand-maintained mirror of what route.ts still handles inline — every name
 * here must NOT also have an inline branch, or the same tool would run twice.
 * scripts/verify-tool-handlers.ts cross-checks that in both directions, which is
 * the standing invariant this codebase now records fifteen instances of.
 */
export const TOOL_HANDLERS: Record<string, ToolHandler> = {
  show_upload_options: showUploadOptions,
  capture_business_fact: captureBusinessFact,
  approve_pending_changes: makeApprovePendingChanges(),
};

/** Closed lookup: the key comes from a model, so `in` would admit a prototype key. */
export function handlerFor(toolName: string): ToolHandler | null {
  return Object.hasOwn(TOOL_HANDLERS, toolName) ? TOOL_HANDLERS[toolName] : null;
}

export const MIGRATED_TOOLS = Object.keys(TOOL_HANDLERS);
