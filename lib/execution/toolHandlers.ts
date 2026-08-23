import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import { persistSyncedRecords } from "@/lib/businessModel/sync";
import { ENTITY_REGISTRY, DesignSchema } from "@/lib/businessModel/entities";
import { toGoalRecordData, toChallengeRecordData } from "@/lib/businessModel/factCapture";
import { UPLOAD_INTENT_REPLY } from "@/lib/dashboard/storeChatUnified";
import {
  AnswerSupplierEconomicsToolInputSchema,
  ApproveCompositionInputSchema,
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
   * The store's active products, as the turn already fetched them.
   *
   * Passed in rather than re-queried: the turn needs them anyway to tell the
   * model what exists, and a handler reading them again would be a second
   * answer to "what does this store sell" one query later.
   */
  products: { id: string; name: string }[];
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
      reply:
        input?.scope === "specific"
          ? `I want to make sure I remove the right one — which product did you mean? Your active products are: ${ctx.products
              .map((p) => p.name)
              .join(", ")}.`
          : ctx.conversationalReply || "Which product would you like me to remove?",
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
