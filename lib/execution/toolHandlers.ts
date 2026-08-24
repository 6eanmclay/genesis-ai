import { randomUUID } from "crypto";
import { stateFact } from "@/lib/businessModel/statements";
import { prisma } from "@/lib/prisma";
import type { BusinessUnderstanding } from "@/lib/businessModel/understanding";
import { ENTITY_REGISTRY, DesignSchema, AssetSchema } from "@/lib/businessModel/entities";
import { ASSET_ROLES } from "@/lib/businessModel/assets";
import { getSurface } from "@/lib/design/surfaces";
import { toGoalRecordData, toChallengeRecordData } from "@/lib/businessModel/factCapture";
import { UPLOAD_INTENT_REPLY, extractRichContentImagePrompt } from "@/lib/dashboard/storeChatUnified";
import {
  AnswerSupplierEconomicsToolInputSchema,
  ApproveCompositionInputSchema,
  CreateDesignInputSchema,
  GenerateBrandLogoInputSchema,
  RefineStorefrontToolInputSchema,
  ApproveDesignAsProductInputSchema,
  CreateCompositionInputSchema,
  TakeMeThereInputSchema,
  type BusinessFactCaptureInput,
} from "@/lib/execution/genesisTools";
import { GENESIS_ACTIONS } from "@/lib/execution/genesisActions";
import { deriveTopicKey } from "@/lib/intelligence/topicKeys";

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

/**
 * A product as the handlers need it.
 *
 * Wider than {id, name} because sourcing a replacement photo needs what the
 * product actually IS — its description and rich content are what a new image
 * gets generated or searched from, and its current image is what must be
 * excluded so the replacement is not the thing being replaced.
 */
export interface TurnProduct {
  id: string;
  name: string;
  description?: string | null;
  imageUrl?: string | null;
  priceInCents?: number | null;
  richContent?: unknown;
}

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
  /**
   * Where to send words as they arrive, when the caller can show them.
   *
   * OPTIONAL, and that is the whole reason this is one handler rather than two.
   * The streaming route can show tokens as they are produced; the Server Action
   * has nowhere to put them and simply omits this. A handler that assumed
   * streaming would have needed a second, non-streaming copy — which is exactly
   * the duplication that let these two paths drift apart in the first place.
   */
  onDelta?: (delta: string) => void;
  /**
   * What J4 said last turn, when there was one.
   *
   * The only state needed to tell "ask" from "ask again" — see
   * buildScopeClarification.
   */
  previousAssistantMessage?: string;
  /**
   * The canonical understanding, already fetched for this turn.
   *
   * Handed in rather than re-read: the turn needed it to decide, and a second
   * read here would be a different answer to "what does J4 know" one query
   * later.
   */
  understanding?: BusinessUnderstanding;
  /**
   * The store's active products, as the turn already fetched them.
   *
   * Passed in rather than re-queried: the turn needs them anyway to tell the
   * model what exists, and a handler reading them again would be a second
   * answer to "what does this store sell" one query later.
   */
  products: TurnProduct[];
}

export type ToolTurnResult =
  | {
      handled: true;
      /** What to say. Never empty — a turn that did something must say so. */
      reply: string;
      /** For the execution log, so a turn is identifiable afterwards. */
      kind: string;
      metadata?: Record<string, unknown>;
      /**
       * Where to send the owner, when the handler's whole job is moving them.
       *
       * Added because take_me_there needed it, not in anticipation: the turn
       * emits the navigation event, so a handler still never touches the stream.
       */
      navigate?: string;
      /**
       * How the turn is logged. Defaults to success.
       *
       * A handler that did its job but could not give the owner what they asked
       * for — no destination resolved — is not a success, and recording it as
       * one hides the cases worth looking at.
       */
      outcome?: "success" | "failure";
      /** What the execution log records, when it differs from what was said. */
      logMessage?: string;
      /**
       * The reply already reached the reader as it was produced.
       *
       * Only true where the caller supplied `onDelta` AND the handler used it.
       * Emitting the text again would show the owner the same answer twice.
       */
      alreadyStreamed?: boolean;
      /**
       * How the execution log records this.
       *
       * PENDING is the honest status for a PROPOSAL: real work happened and
       * nothing changed yet. Defaulting everything to SUCCESS would record a
       * proposed deletion as a completed one.
       */
      executionStatus?: "SUCCESS" | "PENDING" | "WARNING";
      retryable?: boolean;
      /**
       * A path whose cached render is now wrong.
       *
       * Invalidating it is the turn's job, not the handler's: revalidatePath is
       * a framework concern that only makes sense inside a request, and a
       * handler that called it could not be tested outside one.
       */
      revalidate?: string | string[];
      /**
       * Structured payload attached to the assistant's own chat message.
       *
       * How a rendered artefact — a composition, a mockup — reaches the panel
       * that draws it. Distinct from `metadata`, which is for the execution log
       * and is never shown to anybody.
       */
      messageChanges?: Record<string, unknown>;
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

  // THROUGH stateFact, NOT AROUND IT (2026-08-24).
  //
  // This used to call persistSyncedRecords directly and pass
  // `provenance: "OWNER"` as a parameter — a second door on the invariant
  // lib/businessModel/statements.ts exists to hold, whose own comment reads
  // "NOT from the caller. This is the invariant the whole file exists for."
  // Not a hole, since both are server-side and the value was correct, but the
  // shape of one: two ways to assert owner testimony, only one of which could
  // not be told to lie.
  //
  // The identity also changed, and that is the point of the milestone. Every
  // capture used to mint a fresh randomUUID(), so restating a goal produced a
  // SECOND goal and nothing could tell a correction from a new fact. stateFact
  // now resolves an explicit supersession target instead.
  const stated = await stateFact({
    storeId: ctx.storeId,
    userId: ctx.userId,
    entityType,
    data: parsed.data,
    // A model read this out of what the owner said. True whatever they said —
    // the owner is the author, and a model still stood between.
    modelExtracted: true,
    context: "chat",
    supersedesRecordId: input?.supersedesRecordId ?? null,
  });

  // A CORRECTION THAT NAMED SOMETHING UNFINDABLE IS NOT A NEW FACT. Writing it
  // as one would leave the owner believing they had corrected something they
  // had not, which is the exact class of quiet wrongness this milestone exists
  // to end.
  if (!stated.ok) return { handled: false, reason: "invalid_input" };

  const changes = [{ recordId: stated.value.recordId }];

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
/**
 * How a finished approval run is recorded, as opposed to what it says.
 *
 * THE REPLY WAS ALWAYS HONEST AND THE LOG WAS NOT (found 2026-08-23). Every
 * return from this handler omitted `outcome`, `executionStatus` and
 * `retryable`, so a run where nothing applied — including the catch branch
 * whose own comment says "NOTHING WAS APPLIED IN EITHER BRANCH" — was written
 * down as a SUCCESS that could not be retried, while telling the owner it had
 * failed and they could retry it.
 *
 * That is worse than an ordinary mis-log. This is the handler that executes
 * approved changes against a live store, and the logs are where somebody looks
 * to find out whether it has been going wrong.
 */
export function recordApprovalRun(result: {
  totalMembers: number;
  succeeded: unknown[];
  failed: unknown[];
}): {
  outcome: "success" | "failure";
  executionStatus: "SUCCESS" | "WARNING";
  retryable: boolean;
} {
  // Nothing pending is not a failure — the owner asked, and the honest answer
  // is that there was nothing to do.
  if (result.totalMembers === 0) {
    return { outcome: "success", executionStatus: "SUCCESS", retryable: false };
  }
  if (result.failed.length === 0) {
    return { outcome: "success", executionStatus: "SUCCESS", retryable: false };
  }
  // A PARTIAL RUN IS NOT A SUCCESS. Some of what the owner approved did not
  // happen, and the changes that did not are still pending — which is exactly
  // the turn somebody scanning the log needs to find.
  return { outcome: "failure", executionStatus: "WARNING", retryable: true };
}

export function makeApprovePendingChanges(
  execute?: (storeId: string) => Promise<{ ok: boolean; summary: string }>
): ToolHandler {
  return async (ctx) => {
    ctx.status("Applying the approved changes…");
    try {
      if (execute) {
        const result = await execute(ctx.storeId);
        return {
          handled: true,
          reply: result.summary,
          kind: "approve_pending_changes",
          outcome: result.ok ? "success" : "failure",
          executionStatus: result.ok ? "SUCCESS" : "WARNING",
          retryable: !result.ok,
        };
      }
      const { performApprovePendingChanges } = await import("@/app/dashboard/ai-actions");
      const { describeApprovalExecutionForChat } = await import("@/lib/dashboard/pendingApprovals");
      const result = await performApprovePendingChanges(ctx.storeId);
      return {
        handled: true,
        reply: describeApprovalExecutionForChat(result),
        kind: "approve_pending_changes",
        ...recordApprovalRun(result),
        metadata: {
          approvalsAttempted: result.totalMembers,
          approvalsApplied: result.succeeded.length,
          approvalsFailed: result.failed.length,
        },
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
      const refused = err instanceof Error && err.message.includes("permission");
      return {
        handled: true,
        reply: refused
          ? "Approving changes is something only the store owner can do — ask them to approve this, or to give you broader access."
          : "Something went wrong applying those changes — they're still pending, so you can retry from the review page.",
        kind: "approve_pending_changes",
        // NOTHING WAS APPLIED, and the log has to say so. It said SUCCESS until
        // 2026-08-23, in the one handler where that matters most.
        outcome: "failure",
        executionStatus: "WARNING",
        // A refusal is not retryable by this person — telling them to try again
        // would be sending them back into the same wall. A real error is.
        retryable: !refused,
        logMessage: refused
          ? "Approval refused: insufficient permission"
          : `Approval run failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  };
}

/**
 * Where J4 can actually take somebody.
 *
 * A hand-maintained mirror of TakeMeThereInputSchema's own enum, and the
 * mismatch degrades SILENTLY: a destination the schema accepts and this map
 * lacks resolves to null, and the owner is told "I'm not sure where you want to
 * go" about a place J4 was explicitly asked for. scripts/verify-tool-handlers.ts
 * cross-checks the two.
 *
 * THE OFFICE IS DELIBERATELY ABSENT, and that is a correction rather than an
 * omission. It used to map to Studio, so J4 said "Taking you to the Office" and
 * took the owner to Studio instead — one thing said, another done, which is the
 * navigation form of the rule that Genesis must never claim a change it did not
 * make. There is no correct href to substitute: the Office is an overlay over
 * whichever room the owner is already in and has no route of its own. So it is
 * answered rather than navigated, which is also the more useful reply — the
 * owner learns where the door is instead of arriving in the wrong room.
 */
export const NAV_DESTINATIONS: Record<string, { href: string; label: string }> = {
  studio: { href: "/dashboard/studio", label: "Studio" },
  "studio.upload": { href: "/dashboard/studio#bring-your-own", label: "Studio" },
  storefront: { href: "/dashboard/website", label: "your storefront" },
  commerce: { href: "/dashboard/orders", label: "Commerce" },
  account: { href: "/dashboard/settings", label: "your account" },
};

export const OFFICE_REPLY =
  "The Office is always one tap away — it's the control just beneath me, wherever you are. No need to go anywhere.";

/**
 * Take the owner somewhere.
 *
 * `resolveHref` is injected because turning a legacy `/dashboard/...` path into
 * one addressed at THIS business needs the store's slug and the route's own
 * helpers — and because a suite has to be able to check that the business
 * scoping happens at all. Navigating an owner who is in one business into
 * another is the same defect as review links carrying the wrong business, on
 * the one path where J4 moves somebody itself.
 */
export function makeTakeMeThere(resolveHref: (href: string) => string): ToolHandler {
  return async (ctx) => {
    const parsed = TakeMeThereInputSchema.safeParse(ctx.input);

    if (parsed.success && parsed.data.destination === "office") {
      return {
        handled: true,
        reply: ctx.conversationalReply || OFFICE_REPLY,
        kind: "take_me_there",
      };
    }

    // Object.hasOwn even though the schema's enum already closes this: the map
    // is a mirror, and a mirror is exactly where a key that is valid in the type
    // and absent from the runtime table shows up.
    const destination =
      parsed.success && Object.hasOwn(NAV_DESTINATIONS, parsed.data.destination)
        ? NAV_DESTINATIONS[parsed.data.destination]
        : null;

    if (!destination) {
      // Asked to go somewhere and unable to work out where. Honest, and logged
      // as a failure so it is visible rather than counted as a good turn.
      return {
        handled: true,
        reply:
          ctx.conversationalReply ||
          "I'm not sure where you want to go. Tell me what you're trying to do and I'll take you there.",
        kind: "take_me_there",
        outcome: "failure",
      };
    }

    const href = resolveHref(destination.href);
    const reply =
      ctx.conversationalReply ||
      (parsed.success && parsed.data.intent
        ? `Taking you to ${destination.label} for that.`
        : `Taking you to ${destination.label}.`);

    return {
      handled: true,
      reply,
      kind: "take_me_there",
      navigate: href,
      logMessage: `Navigated to ${href}`,
      metadata: {
        destination: parsed.success ? parsed.data.destination : null,
        intent: parsed.success ? parsed.data.intent : null,
      },
    };
  };
}

/**
 * Resolve which products a scoped request is actually about.
 *
 * Shared because request_image_change, request_product_removal and
 * request_product_content_change all take the identical scope shape, and three
 * copies of a matching rule is three chances for "the wipes" to match on one
 * path and not another.
 *
 * Matching is trimmed and case-folded because the model is repeating a name the
 * merchant typed, not quoting the database.
 */
export const SCOPE_QUESTION = "which product did you mean?";

/**
 * The one question J4 asks when it cannot tell which product is meant.
 *
 * Three handlers need it — change the photo on, remove, work on — and two real
 * defects were once duplicated across all three.
 *
 * First, an unresolved scope emitted the MODEL's own free-form reply, which is
 * exactly the shape that restates the merchant's sentence back at them as a
 * question. So this never echoes the model: the question is always grounded in
 * the real active product list.
 *
 * Second, and worse, NO SITE KNEW IT HAD ALREADY ASKED. Every turn recomputed
 * the same clarification from scratch, so a merchant who answered ambiguously
 * could receive the identical question forever. That is the loop: J4 has to
 * advance conversational state, not re-emit it. Asking twice escalates to
 * something answerable with a single character.
 */
export function buildScopeClarification(input: {
  /** What J4 would be doing: "remove", "work on", "change the photo on". */
  verb: string;
  activeNames: string[];
  previousAssistantMessage?: string;
}): string {
  if (input.activeNames.length === 0) {
    return `I don't have any active products to ${input.verb} yet — add one first and I'll take it from there.`;
  }
  if (input.previousAssistantMessage?.includes(SCOPE_QUESTION)) {
    return `Let me make this easier — reply with just the number:\n${input.activeNames
      .map((name, i) => `${i + 1}. ${name}`)
      .join("\n")}`;
  }
  return `I want to make sure I ${input.verb} the right one — ${SCOPE_QUESTION} Your active products are: ${input.activeNames.join(", ")}.`;
}

export function resolveScopedProducts<T extends { name: string }>(
  products: T[],
  scope: "all" | "specific" | null | undefined,
  productNames: string[] | null | undefined
): T[] {
  if (scope === "all") return products;
  if (scope !== "specific") return [];
  const wanted = (productNames ?? []).map((n) => n.trim().toLowerCase());
  return products.filter((p) => wanted.includes(p.name.trim().toLowerCase()));
}

/**
 * Propose removing products. NEVER removes one.
 *
 * delete_product is a hard-locked destructive-category action, so this writes
 * one ApprovalRequest per resolved product and stops. The owner's real
 * confirmation is the existing Approve control on Products, not a second
 * bespoke confirmation here — and the reply says permanently, every time,
 * because a proposal the owner skims should still be unambiguous about what
 * approving it does.
 */
const requestProductRemoval: ToolHandler = async (ctx) => {
  const input = ctx.input as { scope?: "all" | "specific" | null; productNames?: string[] | null };
  const targets = resolveScopedProducts(ctx.products, input?.scope, input?.productNames);

  if (targets.length === 0) {
    // ASKING IS THE RIGHT ANSWER. Removing the wrong product is irreversible,
    // so an unresolved name gets a question naming what actually exists —
    // never a guess at the closest match.
    return {
      handled: true,
      // Never `ctx.conversationalReply` here — see buildScopeClarification.
      reply: buildScopeClarification({
        verb: "remove",
        activeNames: ctx.products.map((p) => p.name),
        previousAssistantMessage: ctx.previousAssistantMessage,
      }),
      kind: "product_removal_request",
      outcome: "failure",
    };
  }

  const groupId = randomUUID();
  for (const product of targets) {
    // A fresh proposal supersedes an earlier still-pending one for the same
    // product, so approving does not delete twice and the owner is not shown
    // the same decision more than once.
    await prisma.approvalRequest.deleteMany({
      where: {
        storeId: ctx.storeId,
        actionType: "delete_product",
        status: "PENDING_APPROVAL",
        input: { path: ["productId"], equals: product.id },
      },
    });
    await prisma.approvalRequest.create({
      data: {
        storeId: ctx.storeId,
        recommendationId: null,
        actionType: "delete_product",
        // The same canonical derivation the backfill uses, so a decision made
        // in conversation enters the belief system identically to one made
        // last January.
        topicKey: deriveTopicKey("delete_product", null),
        input: { productId: product.id, name: product.name },
        previousValues: { productId: product.id, name: product.name },
        summary: `Remove "${product.name}" — this permanently deletes it`,
        authorizationTier: GENESIS_ACTIONS.delete_product.authorizationTier,
        groupId,
      },
    });
  }

  const names = targets.map((p) => p.name);
  const lead =
    ctx.conversationalReply ||
    (names.length > 1
      ? `I've proposed removing ${names.length} products: ${names.join(", ")}.`
      : `I've proposed removing "${names[0]}".`);
  const trailer =
    names.length > 1
      ? "These are grouped as one idea on Products — review and approve each to permanently delete them."
      : "You'll find it waiting for your review on Products — approve it to permanently delete it.";

  return {
    handled: true,
    reply: `${lead} ${trailer}`,
    kind: "product_removal_request",
    // PENDING, not SUCCESS: something real happened and nothing was deleted.
    executionStatus: "PENDING",
    logMessage: `Proposed removing ${names.join(", ")}`,
    metadata: { groupId, productIds: targets.map((p) => p.id) },
  };
};

/**
 * Record what a supplier told the owner about a product's economics.
 *
 * THE REPLY IS CODE-BUILT AND OVERRIDES THE MODEL'S, deliberately. It has to
 * say both what was learned and what is still unknown, and the model wrote its
 * text before any of that was known — so using its words here would state a
 * conclusion about somebody's money that nothing had reached yet.
 *
 * `apply` is injected so a suite can drive the outcomes without standing up a
 * supplier, a product and an outstanding question first. Defaulted to the real
 * implementation, imported lazily like the rest.
 */
export function makeAnswerSupplierEconomics(
  apply?: (input: { storeId: string; answer: unknown }) => Promise<{ status: string; reply: string; [k: string]: unknown }>
): ToolHandler {
  return async (ctx) => {
    ctx.status("Noting that down…");

    const parsed = AnswerSupplierEconomicsToolInputSchema.safeParse(ctx.input);
    if (!parsed.success) {
      // Defence in depth: never build an answer about somebody's money out of a
      // shape that did not validate.
      return { handled: false, reason: "invalid_input" };
    }

    const run =
      apply ??
      (async (input: { storeId: string; answer: unknown }) => {
        const { applyEconomicsAnswer, chatAnswerFrom } = await import("@/lib/sourcing/economicsChat");
        return applyEconomicsAnswer({
          storeId: input.storeId,
          answer: chatAnswerFrom(input.answer as Parameters<typeof chatAnswerFrom>[0]),
        });
      });

    const outcome = await run({ storeId: ctx.storeId, answer: parsed.data });

    return {
      handled: true,
      // The outcome's own words, never ctx.conversationalReply.
      reply: outcome.reply,
      kind: "answer_supplier_economics",
      revalidate: "/dashboard",
      metadata: {
        kind: "answer_supplier_economics",
        resolved: outcome.status,
        ...(outcome.status === "applied" && typeof outcome.result === "object" && outcome.result !== null
          ? {
              productId: (outcome.question as { productId?: string } | undefined)?.productId,
              ...(outcome.result as Record<string, unknown>),
            }
          : {}),
      },
    };
  };
}

/**
 * Plan a real marketing campaign.
 *
 * `plan` is injected because the real one calls a model — a suite can drive
 * both outcomes without a key, and the outcome that matters is the empty one:
 * J4 must say it could not put a plan together rather than implying it did.
 */
export function makePlanCampaign(
  plan?: (storeId: string, message: string) => Promise<{
    name: string;
    groupId: string;
    channels: { channel: string }[];
  } | null>
): ToolHandler {
  return async (ctx) => {
    ctx.status("Planning your campaign…");

    const run =
      plan ??
      (async (storeId: string, message: string) => {
        const { planMarketingCampaign } = await import("@/lib/marketing/campaigns");
        return planMarketingCampaign(storeId, message);
      });

    const planned = await run(ctx.storeId, ctx.userMessage);

    // NOTHING PLANNED IS NOT A CAMPAIGN. Saying so plainly beats a cheerful
    // reply about work that does not exist.
    if (!planned) {
      return {
        handled: true,
        reply:
          "I wasn't able to put a real campaign plan together from that — tell me a bit more about what you're promoting and I'll try again.",
        kind: "campaign_request",
        outcome: "failure",
        metadata: { kind: "campaign_request", groupId: null },
      };
    }

    const channels = planned.channels.map((c) => c.channel).join(", ");
    return {
      handled: true,
      reply: `I've planned "${planned.name}" — ${planned.channels.length} channel${
        planned.channels.length === 1 ? "" : "s"
      }: ${channels}. Take a look and let me know what you'd like to adjust before we schedule it.`,
      kind: "campaign_request",
      metadata: { kind: "campaign_request", groupId: planned.groupId },
    };
  };
}

/**
 * Compose several of the owner's own images into one arrangement.
 *
 * NEVER INVENTS ARTWORK. Composing needs real images the owner already has, so
 * a store without enough of them is told exactly that — and told what to do
 * about it — rather than being handed something made up.
 */
export function makeCreateComposition(
  compose?: (input: { storeId: string; surface: string; columns: number | null; subject: string | null }) => Promise<{
    used: { label: string }[];
    design: { mockupUrl: string; designId: string; surface: string };
  } | null>
): ToolHandler {
  return async (ctx) => {
    const parsed = CreateCompositionInputSchema.safeParse(ctx.input);
    const run =
      compose ??
      (async (input: { storeId: string; surface: string; columns: number | null; subject: string | null }) => {
        const { createComposition } = await import("@/lib/design/composeForStorefront");
        return createComposition(input as Parameters<typeof createComposition>[0]);
      });

    const composed = parsed.success
      ? await run({
          storeId: ctx.storeId,
          surface: parsed.data.surface,
          columns: parsed.data.columns,
          subject: parsed.data.subject,
        })
      : null;

    if (!composed) {
      return {
        handled: true,
        reply:
          ctx.conversationalReply ||
          "I need a few of your images to put a composition together, and I can't find enough yet. Upload some photos or add product images and I'll build it from those.",
        kind: "create_composition",
        outcome: "failure",
      };
    }

    const used = composed.used.map((u) => u.label).join(", ");
    const lead = ctx.conversationalReply || `Here's a composition using ${composed.used.length} of your images.`;
    return {
      handled: true,
      // NAMES WHAT IT USED. A composition the owner cannot trace back to their
      // own files is indistinguishable from one J4 invented.
      reply: `${lead} I used ${used}. Tell me what to change, or say the word and I'll put it on your storefront.`,
      kind: "create_composition",
      revalidate: "/dashboard/studio",
      messageChanges: {
        imageUrl: composed.design.mockupUrl,
        designId: composed.design.designId,
        surface: composed.design.surface,
      },
    };
  };
}

/**
 * Put an approved composition up as a STOREFRONT ASSET — never a product.
 *
 * The distinction is the point: something that makes the store look better is
 * not something a customer can buy, and the reply says so explicitly, because
 * an owner who thinks they just added a product will go looking for it in their
 * catalogue.
 *
 * The design being approved is the newest SECTION one — the thing on screen.
 * Garment designs are deliberately excluded: approving one of those is a
 * product, which is a different tool.
 */
export function makeApproveComposition(
  approve?: (input: {
    storeId: string;
    designId: string;
    role: string;
    summary: string;
    imageUrl: string;
  }) => Promise<string | null>
): ToolHandler {
  return async (ctx) => {
    const parsed = ApproveCompositionInputSchema.safeParse(ctx.input);

    const recent = await prisma.businessRecord.findMany({
      where: { storeId: ctx.storeId, entityType: "design" },
      orderBy: { syncedAt: "desc" },
      take: 10,
      select: { id: true, data: true },
    });
    const sectionDesign = recent
      .map((r) => ({ id: r.id, parsed: DesignSchema.safeParse(r.data) }))
      .find((r) => r.parsed.success && r.parsed.data.surface.startsWith("section."));

    if (!parsed.success || !sectionDesign?.parsed.success || !sectionDesign.parsed.data.mockupUrl) {
      return {
        handled: true,
        reply:
          ctx.conversationalReply ||
          "I don't have a composition on the table to put up. Ask me to make one and I'll show it to you first.",
        kind: "approve_composition",
        outcome: "failure",
      };
    }

    const run =
      approve ??
      (async (input: { storeId: string; designId: string; role: string; summary: string; imageUrl: string }) => {
        const { approveCompositionAsAsset } = await import("@/lib/design/composeForStorefront");
        return approveCompositionAsAsset(input);
      });

    const assetId = await run({
      storeId: ctx.storeId,
      designId: sectionDesign.id,
      role: parsed.data.role,
      summary: parsed.data.summary,
      imageUrl: sectionDesign.parsed.data.mockupUrl,
    });

    // NOTHING SAVED IS NOT A SUCCESS. "Nothing has changed" is the honest
    // sentence, and it is the one that lets an owner retry with confidence.
    if (!assetId) {
      return {
        handled: true,
        reply:
          ctx.conversationalReply ||
          "I couldn't save that just then. Nothing has changed — try me again in a moment.",
        kind: "approve_composition",
        outcome: "failure",
      };
    }

    const lead = ctx.conversationalReply || "Done.";
    return {
      handled: true,
      reply: `${lead} That's saved as your ${parsed.data.role.split(".")[1]} graphic. It's a storefront asset, not something for sale, so it'll show up in how your store looks rather than in your catalog.`,
      kind: "approve_composition",
      revalidate: ["/dashboard/studio", "/dashboard/website"],
      metadata: { assetId, role: parsed.data.role },
    };
  };
}

/**
 * Turn the design on screen into a real product.
 *
 * THE ONE HANDLER THAT CREATES SOMETHING A CUSTOMER CAN BUY, and it runs
 * through the execution engine rather than writing rows itself — so it is a
 * recorded, verified execution like every other real change.
 *
 * execute() never throws for a failure inside run(); it returns a FAILED
 * result. Discarding that would tell the owner their product exists when it
 * does not, which is why the outcome is read rather than assumed.
 *
 * The design is the most recent one, deliberately not asked for by id: the
 * owner is saying yes to the thing on screen, and making the model carry an id
 * through a conversation is a way for it to get the wrong one.
 */
export function makeApproveDesignAsProduct(
  run?: (input: {
    storeId: string;
    designId: string;
    name: string;
    priceInCents: number;
    description?: string;
  }) => Promise<{ status: string }>
): ToolHandler {
  return async (ctx) => {
    const parsed = ApproveDesignAsProductInputSchema.safeParse(ctx.input);

    const latestDesign = await prisma.businessRecord.findFirst({
      where: { storeId: ctx.storeId, entityType: "design" },
      orderBy: { syncedAt: "desc" },
      select: { id: true },
    });

    if (!parsed.success || !latestDesign) {
      return {
        handled: true,
        reply:
          ctx.conversationalReply ||
          "I don't have a design on the table to add. Ask me to make something first and I'll put it in front of you.",
        kind: "approve_design_as_product",
        outcome: "failure",
      };
    }

    const perform =
      run ??
      (async (input: { storeId: string; designId: string; name: string; priceInCents: number; description?: string }) => {
        const { execute } = await import("@/lib/execution/engine");
        const { createProductFromDesignExecutable } = await import(
          "@/lib/execution/executables/productFromDesign"
        );
        return execute(
          createProductFromDesignExecutable,
          {
            designId: input.designId,
            name: input.name,
            priceInCents: input.priceInCents,
            ...(input.description ? { description: input.description } : {}),
          },
          // The business this turn is about, never the account's active one.
          { storeId: input.storeId }
        );
      });

    const result = await perform({
      storeId: ctx.storeId,
      designId: latestDesign.id,
      name: parsed.data.name,
      priceInCents: parsed.data.priceInCents,
      ...(parsed.data.description ? { description: parsed.data.description } : {}),
    });

    const succeeded = result.status === "SUCCESS";
    if (!succeeded) {
      return {
        handled: true,
        reply:
          ctx.conversationalReply ||
          "I couldn't add that to your store just then. Nothing has changed — try me again in a moment.",
        kind: "approve_design_as_product",
        outcome: "failure",
      };
    }

    const lead = ctx.conversationalReply || `Done — "${parsed.data.name}" is in your store now.`;
    return {
      handled: true,
      reply: `${lead} You'll find it under Commerce, and it's live on your storefront.`,
      kind: "approve_design_as_product",
      // The product is real now, so every surface that lists products has to
      // stop serving a page that predates it.
      revalidate: ["/dashboard/studio", "/dashboard/products", "/dashboard/orders"],
      metadata: { designId: latestDesign.id, name: parsed.data.name },
    };
  };
}

interface StorefrontFinding {
  key: string;
  observed: string;
  wouldDo: string;
  composition?: { surface: string; columns: number; subject: string | null } | null;
}

/**
 * Form an opinion about the storefront and show the fix.
 *
 * THE EVALUATION IS FACTS; THE JUDGEMENT IS J4'S. That split is deliberate —
 * "J4 doesn't surface everything he can detect, he decides what is worth
 * bringing to the owner." So the model's own words LEAD, and the findings are
 * appended only when it did not already say something substantive. Talking over
 * a good answer with a generated list is a worse outcome than saying less.
 *
 * A finding with no composition behind it — missing photos, no logo — is still
 * said, and still has nothing to preview. Composing around a gap would HIDE it,
 * which is the opposite of the point.
 */
export function makeImproveStorefront(
  deps?: {
    evaluate?: (storeId: string) => Promise<{ findings: StorefrontFinding[]; productsWithImages: number }>;
    compose?: (input: { storeId: string; surface: string; columns: number; subject: string | null }) => Promise<{
      used: { label: string }[];
      design: { mockupUrl: string };
    } | null>;
  }
): ToolHandler {
  return async (ctx) => {
    const evaluate =
      deps?.evaluate ??
      (async (storeId: string) => {
        const { evaluateStorefront } = await import("@/lib/storefront/evaluate");
        return evaluateStorefront(storeId) as unknown as Promise<{
          findings: StorefrontFinding[];
          productsWithImages: number;
        }>;
      });
    const compose =
      deps?.compose ??
      (async (input: { storeId: string; surface: string; columns: number; subject: string | null }) => {
        const { createComposition } = await import("@/lib/design/composeForStorefront");
        return createComposition(input as Parameters<typeof createComposition>[0]);
      });

    const evaluation = await evaluate(ctx.storeId);
    const actionable = evaluation.findings.find((f) => f.composition);

    let composedUrl: string | null = null;
    let composedFrom: string[] = [];
    if (actionable?.composition) {
      const composed = await compose({
        storeId: ctx.storeId,
        surface: actionable.composition.surface,
        columns: actionable.composition.columns,
        subject: actionable.composition.subject,
      });
      if (composed) {
        composedUrl = composed.design.mockupUrl;
        composedFrom = composed.used.map((u) => u.label);
      }
    }

    const spoken = ctx.conversationalReply?.trim() ?? "";
    const observations = evaluation.findings
      .slice(0, 3)
      .map((f) => `${f.observed} ${f.wouldDo}`)
      .join(" ");

    const parts: string[] = [];
    if (spoken) parts.push(spoken);
    else if (observations) parts.push(observations);
    else
      // NOTHING WRONG IS A REAL ANSWER. Manufacturing a concern to look useful
      // is how an owner learns to stop trusting the ones that matter.
      parts.push(
        "Your storefront is in reasonable shape — nothing structural is standing out to me as worth changing right now."
      );
    if (composedUrl) {
      parts.push(
        `I've put together a version below using ${composedFrom.slice(0, 3).join(", ")}. Have a look, and tell me to use it or change it.`
      );
    }

    return {
      handled: true,
      reply: parts.join(" "),
      kind: "improve_storefront",
      // PENDING: J4 formed an opinion and proposed something. Nothing changed.
      executionStatus: "PENDING",
      logMessage: "Evaluated the storefront",
      ...(composedUrl ? { revalidate: "/dashboard/studio", messageChanges: { imageUrl: composedUrl } } : {}),
      metadata: {
        findings: evaluation.findings.map((f) => f.key),
        productsWithImages: evaluation.productsWithImages,
        proposedComposition: actionable?.composition?.surface ?? null,
      },
    };
  };
}

interface ComposedDesign {
  designId: string;
  mockupUrl: string;
  color: string | null;
  colorVerified: boolean | null;
  contrast: { sufficient: boolean; markIs: string } | null;
}

/**
 * Put the owner's real mark onto a garment.
 *
 * NEVER INVENTS ARTWORK. The asset has to already exist and be designated — if
 * there is no logo, J4 says so plainly and OFFERS to make one rather than
 * making one uninvited. The offer is a sentence the owner can ignore, which is
 * the whole of the no-pressure rule.
 *
 * TWO HONESTY RULES LIVE IN THE CLOSING SENTENCE, and both came from real
 * failures rather than caution.
 *
 * The colour is MEASURED, not assumed. Sean asked for a black hoodie, got a
 * grey one, and was told it was black — so when the render check fails, J4 says
 * the artifact does not look like what was asked for instead of naming a colour
 * it plainly is not.
 *
 * Low contrast is a JUDGEMENT, not a render error. A dark mark on a black
 * garment composes perfectly and is still something nobody would sell. So J4
 * raises it and OFFERS alternatives — it never alters the mark, because
 * changing somebody's logo so it shows up on black is a decision about their
 * brand, and it is theirs.
 */
export function makeCreateDesign(deps?: {
  resolveLogo?: (storeId: string) => Promise<{ id: string } | null>;
  compose?: (input: {
    storeId: string;
    assetIds: string[];
    surface: string;
    color: string | null;
  }) => Promise<ComposedDesign | null>;
}): ToolHandler {
  return async (ctx) => {
    const parsed = CreateDesignInputSchema.safeParse(ctx.input);
    const surfaceKey = parsed.success ? parsed.data.surface : null;
    const surface = surfaceKey ? getSurface(surfaceKey) : null;

    const resolveLogo =
      deps?.resolveLogo ??
      (async (storeId: string) => {
        const { resolveCurrentAsset, ASSET_ROLES } = await import("@/lib/businessModel/assets");
        return resolveCurrentAsset(storeId, ASSET_ROLES.brandLogo);
      });

    const logo = surface ? await resolveLogo(ctx.storeId) : null;
    if (!surface || !logo) {
      return {
        handled: true,
        reply: !surface
          ? ctx.conversationalReply || "I can put your logo on a t-shirt or a hoodie. Which one did you have in mind?"
          : ctx.conversationalReply ||
            "You don't have a logo saved yet, so there's nothing for me to put on it. I can make one based on what I know about your business if you want.",
        kind: "create_design",
        outcome: "failure",
      };
    }

    const compose =
      deps?.compose ??
      (async (input: { storeId: string; assetIds: string[]; surface: string; color: string | null }) => {
        const { createDesign } = await import("@/lib/design/createDesign");
        return createDesign(input as Parameters<typeof createDesign>[0]) as unknown as Promise<ComposedDesign | null>;
      });

    const design = await compose({
      storeId: ctx.storeId,
      assetIds: [logo.id],
      surface: surface.key,
      color: parsed.success ? parsed.data.color : null,
    });

    if (!design) {
      return {
        handled: true,
        reply: ctx.conversationalReply || "I couldn't put that together just now. Try me again in a moment.",
        kind: "create_design",
        outcome: "failure",
      };
    }

    const askedColor = parsed.success ? parsed.data.color : null;
    const colorFailed = Boolean(askedColor) && design.colorVerified === false;
    const contrast = design.contrast;
    const lowContrast = Boolean(contrast && !contrast.sufficient);
    const colorWord = design.color ? design.color : "that colour";
    const lighter = contrast?.markIs === "dark";

    const closing = colorFailed
      ? `I asked for ${askedColor} and what came back doesn't actually look ${askedColor} to me, so don't take my word for it — have a look. Tell me to try the colour again and I will.`
      : lowContrast
        ? `Have a look before you decide though. Your mark is ${contrast!.markIs} and so is the ${colorWord}, so it barely reads against it. I can make a ${
            lighter ? "light" : "dark"
          } version of the mark for this, or put it on a ${
            lighter ? "lighter" : "darker"
          } colour instead. I won't change your logo unless you tell me to.`
        : "That's your real mark composited onto it, not an impression of it, and the print file is ready at full size. Tell me if you want it bigger, smaller, or somewhere else on the garment.";

    const lead = ctx.conversationalReply || `Here's your logo on a ${surface.label.toLowerCase()}.`;
    return {
      handled: true,
      reply: `${lead} ${closing}`,
      kind: "create_design",
      // PENDING: something was made and nothing was applied to the store.
      executionStatus: "PENDING",
      logMessage: `Composed a design on ${surface.label}`,
      // Studio has to SHOW the work — without this the bench still reads
      // "nothing on the bench yet" after J4 has just made something.
      revalidate: "/dashboard/studio",
      messageChanges: { imageUrl: design.mockupUrl, designId: design.designId, surface: surface.key },
      metadata: { designId: design.designId, surface: surface.key, assetIds: [logo.id] },
    };
  };
}

/**
 * Propose a brand logo, grounded in what J4 actually knows about the business.
 *
 * THE NO-PRESSURE RULE IS ENFORCED HERE, in code, rather than trusted to the
 * prompt. An owner who already has a logo is FINISHED — J4 being able to make
 * another is not a reason to raise it. The only thing that overrides that is
 * the owner explicitly asking, which is what ownerDirection carries.
 *
 * That rule used to live only in the tool's description, where the model had no
 * data to obey it: designated assets were not in its context. The digest fixed
 * the context side; this is the side that does not depend on a model reading
 * carefully.
 *
 * ALTERNATIVES ONLY WHEN ASKED. An offer that always fires is not an offer, and
 * they are siblings rather than replacements, so the original survives.
 */
export function makeGenerateBrandLogo(deps?: {
  hasLogo?: (storeId: string) => Promise<boolean>;
  propose?: (input: { storeId: string; ownerDirection: string | null }) => Promise<{
    proposal: { proposalId: string };
    rationale: string;
    groundedIn: unknown;
  } | null>;
  branch?: (input: {
    storeId: string;
    proposalId: string;
    ownerDirection: string | null;
    alternatives: { label: string; intent: string }[];
  }) => Promise<{ branches: unknown[] } | null>;
}): ToolHandler {
  return async (ctx) => {
    const parsed = GenerateBrandLogoInputSchema.safeParse(ctx.input);
    const ownerDirection = parsed.success ? parsed.data.ownerDirection : null;
    const wantsAlternatives = parsed.success ? parsed.data.wantsAlternatives : false;

    const hasLogo =
      deps?.hasLogo ??
      (async (storeId: string) => {
        const { hasExistingLogo } = await import("@/lib/brand/proposeBrandLogo");
        return hasExistingLogo(storeId);
      });

    if ((await hasLogo(ctx.storeId)) && !ownerDirection) {
      return {
        handled: true,
        reply:
          ctx.conversationalReply ||
          "You've already got a logo, and it's yours — I'll work with that one. If you ever want a different direction, say so and I'll put something together.",
        kind: "generate_brand_logo",
      };
    }

    const propose =
      deps?.propose ??
      (async (input: { storeId: string; ownerDirection: string | null }) => {
        const { proposeBrandLogo } = await import("@/lib/brand/proposeBrandLogo");
        return proposeBrandLogo(input) as unknown as Promise<{
          proposal: { proposalId: string };
          rationale: string;
          groundedIn: unknown;
        } | null>;
      });

    const proposed = await propose({ storeId: ctx.storeId, ownerDirection });
    if (!proposed) {
      // Honest failure, the convention every image path here follows: no logo
      // was made, and no placeholder is invented to cover it.
      return {
        handled: true,
        reply: ctx.conversationalReply || "I couldn't get a logo generated just then. Try me again in a moment.",
        kind: "generate_brand_logo",
        outcome: "failure",
      };
    }

    let alternativeCount = 0;
    if (wantsAlternatives) {
      const branch =
        deps?.branch ??
        (async (input: {
          storeId: string;
          proposalId: string;
          ownerDirection: string | null;
          alternatives: { label: string; intent: string }[];
        }) => {
          const { branchBrandLogo } = await import("@/lib/brand/proposeBrandLogo");
          return branchBrandLogo(input) as unknown as Promise<{ branches: unknown[] } | null>;
        });
      const lineage = await branch({
        storeId: ctx.storeId,
        proposalId: proposed.proposal.proposalId,
        ownerDirection,
        alternatives: [
          { label: "Warmer and simpler", intent: "Softer, friendlier, fewer elements. Warmth over polish." },
          { label: "Bolder and more graphic", intent: "Higher contrast, a stronger single shape, more confident." },
        ],
      });
      alternativeCount = lineage?.branches.length ?? 0;
    }

    const lead = ctx.conversationalReply || proposed.rationale;
    const closing =
      alternativeCount > 0
        ? "I've put a couple of other directions beside it. The first one's still there — tell me which way you want to go, or take pieces from more than one."
        : "Have a look below. Tell me what you'd change, or if you're not sure yet I can show you a couple of other directions.";

    return {
      handled: true,
      reply: `${lead} ${closing}`,
      kind: "generate_brand_logo",
      // PENDING: proposed, never applied to the brand.
      executionStatus: "PENDING",
      logMessage: "Proposed a brand logo",
      metadata: { groundedIn: proposed.groundedIn, ownerDirection, alternatives: alternativeCount },
    };
  };
}

/**
 * Does this role mean the owner's brand mark?
 *
 * A REGEX THAT COULD NEVER MATCH shipped here once (corrected 2026-08-22). The
 * line held four literal BACKSPACE bytes (0x08) where its word boundaries were
 * meant to be — a shell heredoc turned every \b into the control character it
 * escapes to. It typechecks, it lints, it reads correctly in an editor, and it
 * is false for every input. So "save this as my logo" never normalised onto
 * brand.logo, never set Store.logoUrl, and "put my logo on a t-shirt" could not
 * find the logo the owner had just given it.
 *
 * Exported so a suite can assert it MATCHES, which is the only kind of test
 * that would have caught that.
 */
export function isLogoRoleName(role: string | null): boolean {
  return Boolean(role && /\blogos?\b|\bmark\b/i.test(role));
}

/**
 * Does this role mean the image at the top of the storefront?
 *
 * Same normalisation, for the role Sean reported as broken in its most direct
 * form: uploading a photo and saying "use this as my hero" designated the role
 * and stopped there, while the composition door — assigning the very same role
 * — changed the site. One role, two meanings, and the one an owner reaches
 * through conversation was the meaningless one.
 */
export function isHeroRoleName(role: string | null): boolean {
  return Boolean(role && /\bhero\b|\bbanner\b/i.test(role));
}

/**
 * Keep a file the owner uploaded, and give it a job.
 *
 * THE OWNER-BRINGS-THEIR-OWN path, which matters as much as generating one: an
 * owner who already has a logo has already answered the question.
 *
 * The role vocabulary stays open, matching AssetSchema — whatever they called
 * it is kept. Only the two roles that MEAN something elsewhere are normalised:
 * the logo, which every render path reads off Store.logoUrl, and the hero,
 * which has to actually reach the storefront rather than sitting on a record.
 */
export function makeManageBusinessAsset(deps?: {
  designate?: (storeId: string, recordId: string, role: string) => Promise<void>;
  setHero?: (storeId: string, url: string) => Promise<void>;
  heroWouldShow?: (storeId: string) => Promise<boolean>;
}): ToolHandler {
  return async (ctx) => {
    const input = ctx.input as { role?: string | null };
    const mostRecentAsset = await prisma.businessRecord.findFirst({
      where: { storeId: ctx.storeId, entityType: "asset" },
      orderBy: { syncedAt: "desc" },
    });

    const requestedRole = input?.role?.trim() || null;
    const isLogo = isLogoRoleName(requestedRole);
    const isHero = isHeroRoleName(requestedRole);
    const roleToAssign = requestedRole
      ? isLogo
        ? ASSET_ROLES.brandLogo
        : isHero
          ? ASSET_ROLES.storefrontHero
          : requestedRole
      : null;

    // Whether the hero image will actually be VISIBLE once set. Three of the
    // four hero layouts render no image at all and the default is one of them,
    // so this is asked rather than assumed. Telling an owner their photo is on
    // the site when the layout cannot show one is the failure to avoid.
    let heroIsVisible = false;

    if (mostRecentAsset && roleToAssign) {
      const designate =
        deps?.designate ??
        (async (storeId: string, recordId: string, role: string) => {
          const { designateAsset } = await import("@/lib/businessModel/assets");
          return designateAsset(storeId, recordId, role);
        });
      await designate(ctx.storeId, mostRecentAsset.id, roleToAssign);

      const parsedAsset = AssetSchema.safeParse(mostRecentAsset.data);
      if (isLogo && parsedAsset.success) {
        // Keep Store.logoUrl in step, exactly as approving a generated logo
        // does — the column is still what every render path reads.
        await prisma.store.update({
          where: { id: ctx.storeId },
          data: { logoUrl: parsedAsset.data.storageUrl },
        });
      }
      if (isHero && parsedAsset.success) {
        const setHero =
          deps?.setHero ??
          (async (storeId: string, url: string) => {
            const { setStorefrontHeroImage } = await import("@/lib/design/composeForStorefront");
            return setStorefrontHeroImage(storeId, url);
          });
        await setHero(ctx.storeId, parsedAsset.data.storageUrl);

        const wouldShow =
          deps?.heroWouldShow ??
          (async (storeId: string) => {
            const { heroLayoutRendersImage, heroLayoutOf } = await import("@/lib/theme");
            const { DEFAULT_THEME } = await import("@/lib/theme");
            const themed = await prisma.store.findUnique({
              where: { id: storeId },
              select: { theme: true },
            });
            return heroLayoutRendersImage(
              heroLayoutOf((themed?.theme as Parameters<typeof heroLayoutOf>[0]) ?? DEFAULT_THEME)
            );
          });
        heroIsVisible = await wouldShow(ctx.storeId);
      }
    }

    const reply = !mostRecentAsset
      ? "I don't see anything uploaded yet to save — share a photo or document and I'll take it from there."
      : roleToAssign
        ? isLogo
          ? "Done — that's your logo now. I'll use it wherever your brand shows up, and you can ask me to put it on a t-shirt or a hoodie whenever you want."
          : isHero
            ? heroIsVisible
              ? "Done — that's the image at the top of your storefront now. Take a look and tell me if you want it different."
              // NEVER "it's on your site" WHEN IT IS NOT VISIBLE. The layout is
              // a real reason and the fix is offered rather than performed.
              : "I've set that as your hero image, but your storefront's current hero layout doesn't show one, so it won't appear yet. Say the word and I'll switch the layout to the split hero so it does."
            : `Done — I've saved that as your ${roleToAssign}. I'll know what you mean when you refer to it.`
        : "That's already saved as part of your business files. Want me to give it a specific role — like your primary logo — or is keeping it on file for now good?";

    return {
      handled: true,
      reply,
      kind: "manage_business_asset",
      metadata: { kind: "manage_business_asset", hadAsset: !!mostRecentAsset, role: input?.role ?? null },
    };
  };
}

/**
 * Find replacement photos for products, and propose them.
 *
 * PROPOSES, never applies — same as the removal path. Each candidate becomes an
 * ApprovalRequest the owner decides on, and a fresh one supersedes an earlier
 * still-pending proposal for the same product so approving cannot apply two.
 *
 * PARTIAL SUCCESS IS THE NORMAL CASE and the reply has to carry it: some
 * products get a candidate and some do not, and saying "done" over the top of
 * that would leave an owner believing every product was handled. So the misses
 * are NAMED, with the honest suggestion to upload those directly.
 */
export function makeRequestImageChange(
  source?: (input: {
    prompt: string;
    name: string;
    description: string | null;
    excludeUrls: string[];
    storeId: string;
  }) => Promise<{ url: string; generationPrompt?: string | null; aiUsageEventId?: string | null } | null>
): ToolHandler {
  return async (ctx) => {
    ctx.status("Finding new photos…");

    const input = ctx.input as { scope?: "all" | "specific" | null; productNames?: string[] | null };
    const targets = resolveScopedProducts(ctx.products, input?.scope, input?.productNames);

    if (targets.length === 0) {
      return {
        handled: true,
        reply: buildScopeClarification({
          verb: "change the photo on",
          activeNames: ctx.products.map((p) => p.name),
          previousAssistantMessage: ctx.previousAssistantMessage,
        }),
        kind: "image_request",
        outcome: "failure",
      };
    }

    const find =
      source ??
      (async (args: {
        prompt: string;
        name: string;
        description: string | null;
        excludeUrls: string[];
        storeId: string;
      }) => {
        const { resolveProductImage } = await import("@/lib/imageProviders/resolveProductImage");
        return resolveProductImage({
          prompt: args.prompt,
          name: args.name,
          description: args.description,
          excludeUrls: args.excludeUrls,
          scope: { storeId: args.storeId },
          feature: "product_image_generation",
        });
      });

    const groupId = randomUUID();
    const outcomes: { id: string; name: string; candidate: string | null }[] = [];

    for (const product of targets) {
      const sourced = await find({
        prompt:
          extractRichContentImagePrompt(product.richContent) ?? product.description ?? product.name,
        name: product.name,
        description: product.description ?? null,
        // The image being replaced is excluded, so the replacement cannot be
        // the thing it is replacing.
        excludeUrls: product.imageUrl ? [product.imageUrl] : [],
        storeId: ctx.storeId,
      });
      const candidate = sourced?.url ?? null;

      if (candidate) {
        await prisma.approvalRequest.deleteMany({
          where: {
            storeId: ctx.storeId,
            actionType: "update_product_image",
            status: "PENDING_APPROVAL",
            input: { path: ["productId"], equals: product.id },
          },
        });
        await prisma.approvalRequest.create({
          data: {
            storeId: ctx.storeId,
            recommendationId: null,
            actionType: "update_product_image",
            topicKey: deriveTopicKey("update_product_image", null),
            input: {
              productId: product.id,
              imageUrl: candidate,
              ...(sourced?.generationPrompt ? { generationPrompt: sourced.generationPrompt } : {}),
            },
            previousValues: {
              productId: product.id,
              imageUrl: product.imageUrl ?? null,
              rejectedCandidates: [],
            },
            summary: `Replace image for "${product.name}"`,
            authorizationTier: GENESIS_ACTIONS.update_product_image.authorizationTier,
            groupId,
            aiUsageEventId: sourced?.aiUsageEventId ?? null,
          },
        });
      }
      outcomes.push({ id: product.id, name: product.name, candidate });
    }

    const found = outcomes.filter((o) => o.candidate).map((o) => o.name);
    const missed = outcomes.filter((o) => !o.candidate).map((o) => o.name);

    const parts = [ctx.conversationalReply || "I'm looking for new photos now."];
    if (found.length > 1) {
      parts.push(
        `These are grouped as one idea on Products — review each, or use "Use all ${found.length}" to apply them together.`
      );
    } else if (found.length === 1) {
      parts.push("You'll find it waiting for your review on Products.");
    }
    // THE MISSES ARE NAMED. Saying "done" over the top of a partial result
    // leaves an owner believing every product was handled.
    if (missed.length > 0) {
      parts.push(
        `I couldn't find a good option for ${missed.join(", ")} — you may want to upload ${
          missed.length > 1 ? "those" : "that one"
        } directly for now.`
      );
    }

    return {
      handled: true,
      reply: parts.join(" "),
      kind: "image_request",
      outcome: found.length > 0 ? "success" : "failure",
      executionStatus: found.length > 0 ? "PENDING" : "WARNING",
      retryable: found.length === 0,
      logMessage:
        found.length > 0
          ? `Proposed new images for ${found.join(", ")}`
          : `Couldn't find new images for ${missed.join(", ")}`,
      metadata: { groupId, productIds: outcomes.filter((o) => o.candidate).map((o) => o.id) },
    };
  };
}

/**
 * Propose a storefront refinement — or REVISE the one already on the table.
 *
 * TWO SEPARATIONS MATTER HERE AND BOTH ARE EASY TO COLLAPSE BY ACCIDENT.
 *
 * The input is validated against the ACTION's own schema, not the tool's. The
 * tool schema guides the model; the action schema is the boundary that decides
 * whether a real ApprovalRequest gets written, and it is the one an executable
 * will later be handed.
 *
 * Directions are read from the RAW tool call, because the action registry
 * deliberately knows nothing about them and strips them. That separation is the
 * point: approving a proposal that offered a choice executes exactly the same
 * shape as one that did not, and the executable's contract is untouched.
 *
 * A REBUTTAL REVISES, IT DOES NOT RESTART. Sean's requirement: "if the owner
 * disagrees with the first idea, J4 should refine the same proposal rather than
 * treating the rebuttal as a new unrelated request." The version this replaced
 * resolved the same recognition by DELETING the earlier row — answering the
 * rebuttal and destroying the evidence of it in one operation, so an owner
 * saying "go back to your first idea" was talking about something that no
 * longer existed.
 *
 * Same target plus an open proposal means revision, decided in code rather than
 * asked of the model — one less field for it to get wrong.
 */
export function makeRefineStorefront(deps?: {
  openProposal?: (storeId: string) => Promise<{
    proposalId: string;
    settled: boolean;
    current: { target: string | null };
  } | null>;
  revise?: (storeId: string, proposalId: string, patch: Record<string, unknown>) => Promise<unknown>;
  open?: (storeId: string, record: Record<string, unknown>) => Promise<unknown>;
  currentTheme?: (storeId: string) => Promise<unknown>;
}): ToolHandler {
  return async (ctx) => {
    const parsed = GENESIS_ACTIONS.refine_storefront.inputSchema.safeParse(ctx.input);
    if (!parsed.success) {
      return {
        handled: true,
        reply:
          ctx.conversationalReply ||
          "I couldn't work out which part of your storefront you meant. Tell me which section and what feels off about it.",
        kind: "refine_storefront",
        outcome: "failure",
      };
    }
    const refineInput = parsed.data as {
      target: string;
      summary: string;
      reason: string;
      changes: unknown;
    };

    // Validated on its own terms, so a malformed or single-item directions
    // array becomes NO directions rather than a broken chooser.
    const rawDirections = (ctx.input as { directions?: unknown })?.directions;
    const parsedDirections = RefineStorefrontToolInputSchema.shape.directions.safeParse(rawDirections);
    const offeredDirections =
      parsedDirections.success && parsedDirections.data
        ? parsedDirections.data.map((d, i) => ({
            // Positional ids. The model is never asked to invent one, which is
            // one less thing it can return inconsistently between the label it
            // shows and the id a button submits.
            id: `d${i + 1}`,
            label: d.label,
            rationale: d.reason,
            changes: d.changes,
          }))
        : [];

    // The real stored theme, never the model's restatement of it, so the
    // approval card diffs against ground truth.
    const readTheme =
      deps?.currentTheme ??
      (async (storeId: string) => {
        const row = await prisma.store.findUnique({ where: { id: storeId }, select: { theme: true } });
        return row?.theme ?? null;
      });
    const previousValues = GENESIS_ACTIONS.refine_storefront.getCurrentValues({
      blueprint: null,
      theme: (await readTheme(ctx.storeId)) as Parameters<
        typeof GENESIS_ACTIONS.refine_storefront.getCurrentValues
      >[0]["theme"],
    });

    const readOpen =
      deps?.openProposal ??
      (async (storeId: string) => {
        const { getOpenProposal } = await import("@/lib/storefront/proposals");
        return getOpenProposal(storeId) as unknown as Promise<{
          proposalId: string;
          settled: boolean;
          current: { target: string | null };
        } | null>;
      });

    const open = await readOpen(ctx.storeId);
    const isRevision = open !== null && open.current.target === refineInput.target && !open.settled;

    if (isRevision) {
      const revise =
        deps?.revise ??
        (async (storeId: string, proposalId: string, patch: Record<string, unknown>) => {
          const { reviseProposal } = await import("@/lib/storefront/proposals");
          return reviseProposal(storeId, proposalId, patch as unknown as Parameters<typeof reviseProposal>[2]);
        });
      await revise(ctx.storeId, open.proposalId, {
        summary: refineInput.summary,
        rationale: refineInput.reason,
        target: refineInput.target,
        input: refineInput as unknown as Record<string, unknown>,
        directions: offeredDirections,
      });
    } else {
      const openRecord =
        deps?.open ??
        (async (storeId: string, record: Record<string, unknown>) => {
          const { openProposal: openProposalRecord } = await import("@/lib/storefront/proposals");
          return openProposalRecord(storeId, record as unknown as Parameters<typeof openProposalRecord>[1]);
        });
      await openRecord(ctx.storeId, {
        actionType: "refine_storefront",
        summary: refineInput.summary,
        rationale: refineInput.reason,
        target: refineInput.target,
        input: refineInput as unknown as Record<string, unknown>,
        previousValues: previousValues as Record<string, unknown>,
        authorizationTier: GENESIS_ACTIONS.refine_storefront.authorizationTier,
        groupId: randomUUID(),
        directions: offeredDirections,
      });
    }

    const lead = ctx.conversationalReply || refineInput.summary;
    // RENDERED BENEATH THIS CONVERSATION, so it must never be described as
    // waiting somewhere else. The copy this replaced sent the owner to the
    // dashboard to find it — the exact trip the persistent layer removes.
    const closing =
      offeredDirections.length > 1
        ? "Have a look below. Flip between them and tell me which way you want to go."
        : isRevision
          ? "I've revised it below. Have a look and tell me if that's closer."
          : "Have a look below. Tell me what you think, or tell me to change it.";

    return {
      handled: true,
      reply: `${lead} ${closing}`,
      kind: "refine_storefront",
      executionStatus: "PENDING",
      logMessage: `Proposed refining ${refineInput.target}`,
      metadata: {
        target: refineInput.target,
        changes: refineInput.changes,
        reason: refineInput.reason,
        revised: isRevision,
        directions: offeredDirections.length,
      },
    };
  };
}

/**
 * Propose better names and descriptions for existing products.
 *
 * PROPOSES — the owner's approval is the existing Approve control on Products,
 * and this exists because J4 used to tell people to paste suggested names in by
 * hand. "If J4 can perform the change, J4 should perform the change after I
 * approve it" (Sean).
 *
 * A SUGGESTION THAT CHANGES NOTHING IS NOT A PROPOSAL. Where the model returns
 * the text that is already there, no ApprovalRequest is written and the product
 * is NAMED as left alone — because a decision card that turns out to change
 * nothing wastes the owner's attention, and quietly dropping it would leave
 * them wondering which products J4 even looked at.
 */
export function makeRequestProductContentChange(
  generate?: (input: {
    storeId: string;
    products: { id: string; name: string; description: string | null; priceInCents: number | null }[];
    changeType: string;
    ownerRequest: string;
  }) => Promise<{ productId: string; name?: string | null; description?: string | null; reasoning?: string | null }[]>
): ToolHandler {
  return async (ctx) => {
    ctx.status("Preparing suggestions…");

    const input = ctx.input as {
      scope?: "all" | "specific" | null;
      productNames?: string[] | null;
      changeType?: string;
    };
    const targets = resolveScopedProducts(ctx.products, input?.scope, input?.productNames);

    if (targets.length === 0) {
      return {
        handled: true,
        reply: buildScopeClarification({
          verb: "work on",
          activeNames: ctx.products.map((p) => p.name),
          previousAssistantMessage: ctx.previousAssistantMessage,
        }),
        kind: "product_content_change_request",
        outcome: "failure",
      };
    }

    const run =
      generate ??
      (async (args: {
        storeId: string;
        products: { id: string; name: string; description: string | null; priceInCents: number | null }[];
        changeType: string;
        ownerRequest: string;
      }) => {
        const { generateProductContentChanges } = await import("@/lib/execution/productContentGeneration");
        return generateProductContentChanges(args as Parameters<typeof generateProductContentChanges>[0]);
      });

    const suggestions = await run({
      storeId: ctx.storeId,
      products: targets.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description ?? null,
        priceInCents: p.priceInCents ?? null,
      })),
      changeType: input?.changeType ?? "both",
      ownerRequest: ctx.userMessage,
    });

    const groupId = randomUUID();
    const proposed: { id: string; name: string }[] = [];
    const unchanged: string[] = [];

    for (const product of targets) {
      const suggestion = suggestions.find((s) => s.productId === product.id);
      const changedFields: { name?: string; description?: string | null } = {};

      if (suggestion?.name && suggestion.name.trim() && suggestion.name.trim() !== product.name) {
        changedFields.name = suggestion.name.trim();
      }
      if (
        input?.changeType !== "name" &&
        suggestion?.description &&
        suggestion.description.trim() &&
        suggestion.description.trim() !== (product.description ?? "")
      ) {
        changedFields.description = suggestion.description.trim();
      }

      if (Object.keys(changedFields).length === 0) {
        unchanged.push(product.name);
        continue;
      }

      await prisma.approvalRequest.deleteMany({
        where: {
          storeId: ctx.storeId,
          actionType: "update_product",
          status: "PENDING_APPROVAL",
          input: { path: ["productId"], equals: product.id },
        },
      });

      const previousValues: Record<string, unknown> = { productId: product.id };
      if ("name" in changedFields) previousValues.name = product.name;
      if ("description" in changedFields) previousValues.description = product.description ?? null;

      await prisma.approvalRequest.create({
        data: {
          storeId: ctx.storeId,
          recommendationId: null,
          actionType: "update_product",
          topicKey: deriveTopicKey("update_product", { productId: product.id, ...changedFields }),
          input: { productId: product.id, ...changedFields },
          previousValues,
          summary: suggestion?.reasoning
            ? `${product.name}: ${suggestion.reasoning}`
            : `Update "${product.name}"`,
          authorizationTier: GENESIS_ACTIONS.update_product.authorizationTier,
          groupId,
        },
      });
      proposed.push({ id: product.id, name: product.name });
    }

    const parts = [ctx.conversationalReply || "I've looked at your products."];
    if (proposed.length > 1) {
      parts.push(
        `I've proposed changes for ${proposed.length}: ${proposed
          .map((p) => p.name)
          .join(", ")} — review each on Products, or approve all together.`
      );
    } else if (proposed.length === 1) {
      parts.push(`You'll find my proposed change for "${proposed[0].name}" waiting for your review on Products.`);
    }
    if (unchanged.length > 0) {
      parts.push(
        `${unchanged.length > 1 ? "These" : "One"} already read${
          unchanged.length > 1 ? "" : "s"
        } well as-is, so I left ${unchanged.length > 1 ? "them" : "it"} unchanged: ${unchanged.join(", ")}.`
      );
    }

    return {
      handled: true,
      reply: parts.join(" "),
      kind: "product_content_change_request",
      outcome: proposed.length > 0 ? "success" : "failure",
      executionStatus: proposed.length > 0 ? "PENDING" : "WARNING",
      retryable: proposed.length === 0,
      logMessage:
        proposed.length > 0
          ? `Proposed content changes for ${proposed.map((p) => p.name).join(", ")}`
          : "No real content changes to propose",
      metadata: { groupId, productIds: proposed.map((p) => p.id) },
    };
  };
}

/**
 * Answer a real question from the business's own data.
 *
 * THE ONE HANDLER THAT SPEAKS IN THE MODEL'S OWN WORDS, because the answer IS
 * the work — everything else here does something and then reports it.
 *
 * Streams when the caller can show it. `ctx.onDelta` is optional precisely so
 * this is one implementation rather than two: the route pipes tokens to the
 * owner as they arrive, the Server Action has nowhere to put them, and neither
 * needs its own copy of what to send the model. A second copy is how these two
 * paths drifted before.
 *
 * A FAILED CALL IS NOT AN EMPTY ANSWER. If the model fails or says nothing, the
 * handler refuses rather than persisting a blank reply — an empty assistant
 * message in somebody's conversation is worse than an honest failure.
 */
export function makeLookUpBusinessData(deps?: {
  answer?: (input: {
    storeId: string;
    payload: unknown;
    question: string;
    onDelta?: (delta: string) => void;
  }) => Promise<{ ok: boolean; text: string }>;
}): ToolHandler {
  return async (ctx) => {
    if (!ctx.understanding) {
      // Unreachable through either real path — both fetch it before deciding —
      // and refused rather than re-read, because a handler quietly issuing its
      // own understanding query is how a second source of truth begins.
      return { handled: false, reason: "invalid_input" };
    }
    const understanding = ctx.understanding;

    const { buildChatDataContext } = await import("@/lib/businessModel/reasoning");
    const { findRelevantDecisions } = await import("@/lib/businessModel/reasoning");
    const { findRelevantMessages } = await import("@/lib/businessModel/conversationRecall");
    const { groundingRules, unsourcedCount } = await import("@/lib/businessModel/grounding");

    const [dataContext, pastDecisions, pastStatements] = await Promise.all([
      buildChatDataContext(ctx.storeId),
      findRelevantDecisions(ctx.storeId, ctx.userMessage),
      // The owner's own past words, any age — the same relevance-over-recency
      // rule the decisions above follow.
      findRelevantMessages(ctx.storeId, ctx.userMessage),
    ]);

    const sourced = [
      ...understanding.profile.goals,
      ...understanding.profile.challenges,
      ...understanding.profile.assets,
    ];

    const payload = {
      ...dataContext,
      businessProfile: understanding.profile,
      // The provenance is already on those records; carrying it without
      // explaining how to read it is just more JSON.
      sourceGuidance: groundingRules(sourced),
      factsWithNoRecordedSource: unsourcedCount(sourced),
      beliefs: understanding.beliefs,
      recentDecisions: understanding.recentDecisions,
      pastDecisionsRelevantToThisQuestion: pastDecisions,
      pastStatementsByTheOwnerRelevantToThisQuestion: pastStatements,
      commitments: understanding.commitments,
      // Patterns about the owner, not the business — populated only for the
      // owner themselves.
      ownerUnderstanding: understanding.ownerUnderstanding,
      activeThoughts: understanding.activeThoughts,
      growthPointBalance: understanding.platformRelationship.growthPointBalance,
    };

    const ask =
      deps?.answer ??
      (async (input: {
        storeId: string;
        payload: unknown;
        question: string;
        onDelta?: (delta: string) => void;
      }) => {
        const { callGenesisModel } = await import("@/lib/genesisModel");
        const { withJ4CopyRules } = await import("@/lib/j4CopyRules");
        const { STORE_CHAT_DATA_ANSWER_SYSTEM_PROMPT } = await import("@/lib/dashboard/storeChatUnified");
        const { growthPointCostsFor } = await import("@/lib/growthPoints/catalog");
        const { PROPOSABLE_ACTION_TYPES } = await import("@/lib/intelligence/cognitiveLayer");

        let text = "";
        const outcome = await callGenesisModel(
          {
            model: "claude-opus-4-8",
            max_tokens: 1500,
            thinking: { type: "adaptive" },
            system: withJ4CopyRules(STORE_CHAT_DATA_ANSWER_SYSTEM_PROMPT),
            messages: [
              {
                role: "user",
                content: `Business data (JSON):\n${JSON.stringify(
                  {
                    ...(input.payload as object),
                    growthPointCosts: growthPointCostsFor(PROPOSABLE_ACTION_TYPES),
                  },
                  null,
                  2
                )}\n\nMerchant's question: ${input.question}`,
              },
            ],
          },
          {
            storeId: input.storeId,
            feature: "store_chat_data_answer",
            // PLAIN TEXT, no structured output: a structured call's raw stream
            // is JSON matching the schema grammar, and piping that to a reader
            // leaks syntax into the visible answer.
            onTextDelta: (delta) => {
              text += delta;
              input.onDelta?.(delta);
            },
          }
        );
        return { ok: outcome.ok, text };
      });

    const answered = await ask({
      storeId: ctx.storeId,
      payload,
      question: ctx.userMessage,
      onDelta: ctx.onDelta,
    });

    if (!answered.ok || !answered.text) {
      return { handled: false, reason: "invalid_input" };
    }

    return {
      handled: true,
      reply: answered.text,
      kind: "data_question",
      // The words were already sent to the reader as they arrived, where the
      // caller could show them — emitting them again would duplicate the answer.
      alreadyStreamed: Boolean(ctx.onDelta),
    };
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
  request_product_removal: requestProductRemoval,
  answer_supplier_economics: makeAnswerSupplierEconomics(),
  plan_campaign: makePlanCampaign(),
  create_composition: makeCreateComposition(),
  approve_composition: makeApproveComposition(),
  approve_design_as_product: makeApproveDesignAsProduct(),
  improve_storefront: makeImproveStorefront(),
  create_design: makeCreateDesign(),
  generate_brand_logo: makeGenerateBrandLogo(),
  manage_business_asset: makeManageBusinessAsset(),
  request_image_change: makeRequestImageChange(),
  refine_storefront: makeRefineStorefront(),
  request_product_content_change: makeRequestProductContentChange(),
  look_up_business_data: makeLookUpBusinessData(),
  // Bound to the real href resolver by the route, which is the only place that
  // knows this business's slug. The registry entry here would navigate to the
  // ACCOUNT'S ACTIVE business rather than the one the owner is in, so it is
  // deliberately not registered — see routeToolHandlers below.
};

/**
 * The registry, with the handlers that need something only the request knows.
 *
 * take_me_there is the first: turning a legacy `/dashboard/...` path into one
 * addressed at THIS business needs the store's slug. Registering the unbound
 * version would silently navigate an owner who is in one business into
 * whichever one their account last made active.
 */
export function routeToolHandlers(bind: {
  resolveHref: (href: string) => string;
}): Record<string, ToolHandler> {
  return {
    ...TOOL_HANDLERS,
    take_me_there: makeTakeMeThere(bind.resolveHref),
  };
}

/** Closed lookup: the key comes from a model, so `in` would admit a prototype key. */
export function handlerFor(toolName: string): ToolHandler | null {
  return Object.hasOwn(TOOL_HANDLERS, toolName) ? TOOL_HANDLERS[toolName] : null;
}

/**
 * Every tool that no longer has an inline branch.
 *
 * Includes the bound ones, because "has it moved out of the ladder" is the
 * question this answers — not "is it in the static map".
 */
export const MIGRATED_TOOLS = [...Object.keys(TOOL_HANDLERS), "take_me_there"];
