import { randomUUID } from "crypto";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { PERMISSIONS, hasPermission, resolveUserStore } from "@/lib/permissions";
import { callGenesisModel, genesisModelFailureMessage } from "@/lib/genesisModel";
import { EXECUTION_ACTIONS } from "@/lib/execution/actions";
import { recordGenesisExecution } from "@/lib/execution/genesis";
import { GENESIS_ACTIONS } from "@/lib/execution/genesisActions";
import { logProductEvent, findLikelyRephraseOf } from "@/lib/telemetry/events";
import { buildChatDataContext } from "@/lib/businessModel/reasoning";
import { getBusinessUnderstanding } from "@/lib/businessModel/understanding";
import { persistSyncedRecords } from "@/lib/businessModel/sync";
import { ENTITY_REGISTRY } from "@/lib/businessModel/entities";
import { toGoalRecordData, toChallengeRecordData } from "@/lib/businessModel/factCapture";
import { growthPointCostsFor } from "@/lib/growthPoints/catalog";
import { PROPOSABLE_ACTION_TYPES } from "@/lib/intelligence/cognitiveLayer";
import { planMarketingCampaign } from "@/lib/marketing/campaigns";
import { resolveProductImage } from "@/lib/imageProviders/resolveProductImage";
import {
  buildStoreChatUnifiedTools,
  firstToolUse,
  textOf,
  type BusinessFactCaptureInput,
  type RequestImageChangeInput,
} from "@/lib/execution/genesisTools";
import {
  UploadIntentSchema,
  STORE_CHAT_UPLOAD_INTENT_SYSTEM_PROMPT,
  UPLOAD_INTENT_REPLY,
  STORE_CHAT_DATA_ANSWER_SYSTEM_PROMPT,
  STORE_CHAT_UNIFIED_SYSTEM_PROMPT,
  extractRichContentImagePrompt,
} from "@/lib/dashboard/storeChatUnified";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

// Response Modes plan (2026-08-07), Phase 2 — real token streaming for the
// fast paths Phase 1's unified call already collapsed (pure conversation,
// look_up_business_data, capture_business_fact, plan_campaign,
// request_image_change). A Route Handler, not a Server Action, because real
// streaming to the browser needs a raw ReadableStream response — Server
// Actions can't do that (confirmed against this repo's own bundled Next.js
// docs, node_modules/next/dist/docs/01-app/02-guides/streaming.md's
// "Streaming in Route Handlers" section; Vercel supports it natively).
//
// Deliberately scoped: genuine content-edit requests (edit_store_content,
// or anything the unified call doesn't resolve into a real reply) are NOT
// handled here. Duplicating PRIMARY/SECONDARY/COMPOSITION's ~150 lines of
// content-generation logic into a second implementation would be a real,
// unnecessary risk to the app's most complex write path. Instead this
// route emits a `fallback` event and the client falls back to the existing,
// unchanged, already-working Server Action (sendStoreMessage ->
// applyGenesisMessageToStore), full page redirect and all — slower, but
// exactly as reliable as it is today. The user's own StoreMessage row is
// deliberately NOT written until we know which path we're taking, so a
// fallback never produces a duplicate.
export const maxDuration = 300;
// Real production bug (2026-08-07) — a purely conversational message got
// misrouted into the heavy fallback path; while diagnosing it, verified
// there's no accidental buffering in this route's own code (every text
// delta is enqueued to the stream the instant it arrives, nothing is
// accumulated server-side first) but added this defensively anyway, so
// Next.js never applies any static-optimization/caching path to a route
// that must always stream fresh, per-request output.
export const dynamic = "force-dynamic";

const CHAT_HISTORY_WINDOW = 50;
const encoder = new TextEncoder();

type StreamEvent =
  | { type: "padding"; data: string }
  | { type: "status"; text: string }
  | { type: "token"; delta: string }
  | { type: "done"; changes: string[] | null }
  | { type: "fallback" }
  | { type: "error"; message: string };

function encodeEvent(event: StreamEvent): Uint8Array {
  return encoder.encode(`${JSON.stringify(event)}\n`);
}

async function logStreamedChatTurn(params: {
  userId: string;
  storeId: string;
  durationMs: number;
  outcome: "success" | "failure";
  likelyRephraseOf: string | null;
  kind: string;
}) {
  const session = await auth();
  if (!session?.user) return;
  await logProductEvent({
    userId: params.userId,
    storeId: params.storeId,
    storeDraftId: null,
    sessionInstanceId: session.user.sessionInstanceId,
    name: "chat.turn_completed",
    category: "chat",
    attemptKey: params.storeId,
    outcome: params.outcome,
    durationMs: params.durationMs,
    metadata: { requiresConfirmation: false, likelyRephraseOf: params.likelyRephraseOf, kind: params.kind, streamed: true },
  }).catch(() => {});
}

// Temporary production tracing (2026-08-08) — real phone tests kept
// failing after fixes that were only ever verified against isolated API
// calls and a trivial diag route, so this traces the exact real request
// end to end: server checkpoints here, client checkpoints in
// GenesisAssistant.tsx, correlated via one shared requestId and logged so
// `vercel logs` shows the real, complete timeline of one real turn. Delete
// once the actual failing layer is identified and fixed.
function diagLog(requestId: string, turnStartedAt: number, event: string, meta?: Record<string, unknown>) {
  console.log(
    `[genesis-chat-diag] side=server requestId=${requestId} event=${event} tMs=${Date.now() - turnStartedAt} meta=${JSON.stringify(meta ?? {})}`
  );
}

export async function POST(request: Request) {
  const turnStartedAt = Date.now();
  const body = (await request.json().catch(() => null)) as
    | { message?: string; requestId?: string }
    | null;
  const requestId = body?.requestId ?? "unknown";
  diagLog(requestId, turnStartedAt, "request_received");

  const session = await auth();
  if (!session?.user) {
    diagLog(requestId, turnStartedAt, "auth_failed");
    return new Response(JSON.stringify({ type: "error", message: "Not signed in." }), { status: 401 });
  }
  const userId = session.user.id;

  const userMessage = body?.message?.trim();
  if (!userMessage) {
    return new Response(JSON.stringify({ type: "error", message: "Empty message." }), { status: 400 });
  }

  const resolved = await resolveUserStore(userId);
  if (!resolved || !hasPermission(resolved.role, PERMISSIONS.GENESIS_CHAT)) {
    diagLog(requestId, turnStartedAt, "permission_failed");
    return new Response(JSON.stringify({ type: "error", message: "No permission." }), { status: 403 });
  }
  const { store, role } = resolved;
  diagLog(requestId, turnStartedAt, "auth_and_store_resolved", { storeId: store.id });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Real production bug (2026-08-07) — the client never visibly
      // streamed on a real phone despite every isolated test (raw API,
      // raw platform chunk-timing) proving real incremental delivery.
      // This project's own bundled Next.js docs name the actual cause:
      // "Safari/WebKit buffers streaming responses until 1024 bytes have
      // been received, so very small responses paint all at once instead
      // of progressively." A short conversational reply (the exact case
      // this whole plan targets) easily stays under 1KB, so Safari held
      // the entire thing back regardless of real server-side timing.
      // Standard, well-documented workaround: send enough inert padding
      // immediately, before any real content, to cross that threshold —
      // the client discards this event on sight.
      controller.enqueue(encoder.encode(`${JSON.stringify({ type: "padding", data: " ".repeat(1200) })}\n`));
      diagLog(requestId, turnStartedAt, "padding_chunk_enqueued");

      // Real production bug (2026-08-07), second half — a client
      // disconnect (backgrounding the tab, navigating away) makes
      // controller.enqueue() throw once the underlying connection is
      // gone. Uncaught, that exception propagated out of this function
      // before the real reply was ever persisted — the model call might
      // still have been mid-flight, but the turn was abandoned with
      // nothing written, so returning to the conversation had nothing
      // real to recover. emit() must never let a dead connection abort
      // generation or persistence — the model call and the DB write below
      // must complete regardless of whether anyone is still listening.
      const emit = (event: StreamEvent) => {
        try {
          controller.enqueue(encodeEvent(event));
        } catch {
          // Client is gone. Not a reason to stop generating or persisting
          // the real result — only a reason to stop trying to show it.
        }
      };
      try {
        const recentMessages = await prisma.storeMessage.findMany({
          where: { storeId: store.id },
          orderBy: { createdAt: "desc" },
          take: CHAT_HISTORY_WINDOW,
        });
        const existingMessages = recentMessages.reverse();
        const likelyRephraseOf = findLikelyRephraseOf(
          userMessage,
          existingMessages.filter((m) => m.role === "user")
        );

        // Upload-intent — same permission-safety reason as the Server
        // Action version: must run before the store:manage gate, since
        // pointing at the upload buttons is safe for any role with chat
        // access.
        const uploadIntentOutcome = await callGenesisModel(
          {
            model: "claude-opus-4-8",
            max_tokens: 200,
            thinking: { type: "adaptive" },
            system: STORE_CHAT_UPLOAD_INTENT_SYSTEM_PROMPT,
            messages: [{ role: "user", content: userMessage }],
            output_config: { effort: "low", format: zodOutputFormat(UploadIntentSchema) },
          },
          { storeId: store.id, feature: "store_chat_upload_intent_detection" }
        );
        const uploadIntentResult = uploadIntentOutcome.ok ? uploadIntentOutcome.message.parsed_output : null;
        diagLog(requestId, turnStartedAt, "upload_intent_classified", { isUploadIntent: !!uploadIntentResult?.isUploadIntent });

        if (uploadIntentResult?.isUploadIntent) {
          await prisma.storeMessage.create({ data: { storeId: store.id, role: "user", content: userMessage } });
          await prisma.storeMessage.create({ data: { storeId: store.id, role: "assistant", content: UPLOAD_INTENT_REPLY } });
          await recordGenesisExecution({
            action: EXECUTION_ACTIONS.GENESIS_STORE_MESSAGE,
            status: "SUCCESS",
            verified: false,
            message: UPLOAD_INTENT_REPLY,
            retryable: false,
            userId,
            storeId: store.id,
            metadata: { kind: "upload_intent" },
          });
          emit({ type: "token", delta: UPLOAD_INTENT_REPLY });
          emit({ type: "done", changes: null });
          await logStreamedChatTurn({ userId, storeId: store.id, durationMs: Date.now() - turnStartedAt, outcome: "success", likelyRephraseOf, kind: "upload_intent" });
          controller.close();
          return;
        }

        if (!hasPermission(role, PERMISSIONS.STORE_MANAGE)) {
          const declineMessage =
            "That's something only the store owner can change — I don't have permission to update store settings, branding, or policies on your account. Ask them to make this change, or to give you broader access.";
          await prisma.storeMessage.create({ data: { storeId: store.id, role: "user", content: userMessage } });
          await prisma.storeMessage.create({ data: { storeId: store.id, role: "assistant", content: declineMessage } });
          await recordGenesisExecution({
            action: EXECUTION_ACTIONS.GENESIS_STORE_MESSAGE,
            status: "WARNING",
            verified: false,
            message: declineMessage,
            retryable: false,
            userId,
            storeId: store.id,
            metadata: {},
          });
          emit({ type: "token", delta: declineMessage });
          emit({ type: "done", changes: null });
          await logStreamedChatTurn({ userId, storeId: store.id, durationMs: Date.now() - turnStartedAt, outcome: "failure", likelyRephraseOf, kind: "declined" });
          controller.close();
          return;
        }

        const currentProducts = await prisma.product.findMany({
          where: { storeId: store.id, active: true },
          select: { id: true, name: true, description: true, priceInCents: true, imageUrl: true, richContent: true },
          orderBy: { position: "asc" },
        });
        const pending = store.pendingChange as { summary: string } | null;
        const activeProductNames = currentProducts.map((p) => p.name).join(", ") || "none";
        const unifiedContextParts = [userMessage, `(Active products: ${activeProductNames})`];
        if (pending) {
          unifiedContextParts.push(`(You previously proposed this change, awaiting confirmation: "${pending.summary}")`);
        }
        const conversationMessages = existingMessages.map((m) => ({
          role: (m.role === "user" ? "user" : "assistant") as "user" | "assistant",
          content: m.content,
        }));
        const cachedConversationMessages =
          conversationMessages.length > 0
            ? [
                ...conversationMessages.slice(0, -1),
                {
                  role: conversationMessages[conversationMessages.length - 1].role,
                  content: [
                    {
                      type: "text" as const,
                      text: conversationMessages[conversationMessages.length - 1].content,
                      cache_control: { type: "ephemeral" as const },
                    },
                  ],
                },
              ]
            : conversationMessages;

        emit({ type: "status", text: "Understanding your request…" });
        diagLog(requestId, turnStartedAt, "status_understanding_emitted");

        let streamedAnyText = false;
        // Real TTFT vs. total-duration instrumentation (Sean, 2026-08-07) —
        // "the user seeing the first real words as quickly as possible" is
        // a materially different number than total call time, and needs to
        // be measured separately, not conflated. Logged below alongside the
        // rest of this turn's real timing.
        let firstTokenAtMs: number | null = null;
        diagLog(requestId, turnStartedAt, "unified_call_started");
        const unifiedRequestMessages = [...cachedConversationMessages, { role: "user" as const, content: unifiedContextParts.join("\n") }];
        const unifiedOutcome = await callGenesisModel(
          {
            model: "claude-opus-4-8",
            max_tokens: 1500,
            thinking: { type: "adaptive" },
            system: [{ type: "text", text: STORE_CHAT_UNIFIED_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
            messages: unifiedRequestMessages,
            tools: buildStoreChatUnifiedTools(),
            tool_choice: { type: "auto" },
          },
          {
            storeId: store.id,
            feature: "store_chat_unified_triage",
            // Real live streaming — the whole point of this route. Every
            // delta is enqueued to the response stream the instant it's
            // received from the SDK's own stream event — nothing is
            // accumulated or batched server-side first.
            onTextDelta: (delta) => {
              if (firstTokenAtMs === null) {
                firstTokenAtMs = Date.now() - turnStartedAt;
                diagLog(requestId, turnStartedAt, "unified_first_model_delta", { deltaLength: delta.length });
              }
              streamedAnyText = true;
              emit({ type: "token", delta });
            },
          }
        );
        console.log(`[genesis-chat-ttft] ttftMs=${firstTokenAtMs ?? "n/a"} sinceUnifiedCallStartMs=${Date.now() - turnStartedAt}`);
        diagLog(requestId, turnStartedAt, "unified_call_finished", {
          ok: unifiedOutcome.ok,
          stopReason: unifiedOutcome.ok ? unifiedOutcome.message.stop_reason : null,
        });

        if (!unifiedOutcome.ok) {
          // Temporary production diagnostic (2026-08-08) — the one piece
          // the earlier trace was missing: kind:"invalid_request" alone
          // doesn't say WHY Anthropic rejected the request. roleSequence
          // catches a role-alternation violation (Anthropic requires
          // strict user/assistant alternation; StoreMessage has no such
          // constraint) at a glance; message is the real BadRequestError
          // text (see classifyAnthropicError) truncated, never full
          // request/message content — no owner business data logged.
          diagLog(requestId, turnStartedAt, "unified_call_failed", {
            kind: unifiedOutcome.kind,
            status: unifiedOutcome.status,
            message: unifiedOutcome.message.slice(0, 300),
            roleSequence: unifiedRequestMessages.map((m) => m.role),
            messageCount: unifiedRequestMessages.length,
          });
          emit({ type: "fallback" });
          controller.close();
          return;
        }

        const chosenTool = firstToolUse(unifiedOutcome.message.content);
        const conversationalReply = textOf(unifiedOutcome.message.content);

        // Pure conversation — already fully streamed above. Persist and
        // finish; no further model or tool work needed.
        if (!chosenTool && conversationalReply) {
          diagLog(requestId, turnStartedAt, "db_write_start", { kind: "conversational" });
          await prisma.storeMessage.create({ data: { storeId: store.id, role: "user", content: userMessage } });
          await prisma.storeMessage.create({ data: { storeId: store.id, role: "assistant", content: conversationalReply } });
          await recordGenesisExecution({
            action: EXECUTION_ACTIONS.GENESIS_STORE_MESSAGE,
            status: "SUCCESS",
            verified: false,
            message: conversationalReply,
            retryable: false,
            userId,
            storeId: store.id,
            metadata: { kind: "conversational" },
          });
          diagLog(requestId, turnStartedAt, "db_write_done", { kind: "conversational" });
          emit({ type: "done", changes: null });
          diagLog(requestId, turnStartedAt, "stream_done_emitted", { kind: "conversational" });
          await logStreamedChatTurn({ userId, storeId: store.id, durationMs: Date.now() - turnStartedAt, outcome: "success", likelyRephraseOf, kind: "conversational" });
          controller.close();
          diagLog(requestId, turnStartedAt, "controller_closed", { kind: "conversational" });
          return;
        }

        if (chosenTool?.name === "look_up_business_data") {
          diagLog(requestId, turnStartedAt, "tool_selected", { tool: "look_up_business_data" });
          emit({ type: "status", text: "Reviewing your storefront…" });
          diagLog(requestId, turnStartedAt, "status_reviewing_emitted");
          const [dataContext, understanding] = await Promise.all([
            buildChatDataContext(store.id),
            getBusinessUnderstanding(store.id),
          ]);
          diagLog(requestId, turnStartedAt, "data_context_fetched");
          // Real bug found live (2026-08-07) — this call previously used
          // structured output (zodOutputFormat), which meant its own reply
          // text was never actually streamed: the whole point of this route
          // is real token streaming, but a structured-output call's raw
          // stream is JSON matching the schema grammar (`{"reply": "...`),
          // not clean prose — piping that straight to onTextDelta would
          // leak JSON syntax into the visible text. Switched to plain text
          // (no output_config), matching the unified call's own
          // conversational branch, so this is now a genuine live stream —
          // the previous code awaited the full response and emitted it as
          // one block, which is what actually produced "buffered paragraph
          // appears all at once," not a platform-level streaming problem.
          let dataAnswerReply = "";
          diagLog(requestId, turnStartedAt, "data_answer_call_started");
          const answerOutcome = await callGenesisModel(
            {
              model: "claude-opus-4-8",
              max_tokens: 1500,
              thinking: { type: "adaptive" },
              system: STORE_CHAT_DATA_ANSWER_SYSTEM_PROMPT,
              messages: [
                {
                  role: "user",
                  content: `Business data (JSON):\n${JSON.stringify(
                    {
                      ...dataContext,
                      businessProfile: understanding.profile,
                      beliefs: understanding.beliefs,
                      recentDecisions: understanding.recentDecisions,
                      activeThoughts: understanding.activeThoughts,
                      growthPointBalance: understanding.platformRelationship.growthPointBalance,
                      growthPointCosts: growthPointCostsFor(PROPOSABLE_ACTION_TYPES),
                    },
                    null,
                    2
                  )}\n\nMerchant's question: ${userMessage}`,
                },
              ],
            },
            {
              storeId: store.id,
              feature: "store_chat_data_answer",
              onTextDelta: (delta) => {
                if (firstTokenAtMs === null) {
                  firstTokenAtMs = Date.now() - turnStartedAt;
                  diagLog(requestId, turnStartedAt, "data_answer_first_model_delta", { deltaLength: delta.length });
                }
                streamedAnyText = true;
                dataAnswerReply += delta;
                emit({ type: "token", delta });
              },
            }
          );
          diagLog(requestId, turnStartedAt, "data_answer_call_finished", { ok: answerOutcome.ok, replyLength: dataAnswerReply.length });
          if (!answerOutcome.ok || !dataAnswerReply) {
            diagLog(requestId, turnStartedAt, "data_answer_failed");
            emit({ type: "error", message: genesisModelFailureMessage(answerOutcome.ok ? "unknown" : answerOutcome.kind) });
            controller.close();
            return;
          }
          diagLog(requestId, turnStartedAt, "db_write_start", { kind: "data_question" });
          await prisma.storeMessage.create({ data: { storeId: store.id, role: "user", content: userMessage } });
          await prisma.storeMessage.create({ data: { storeId: store.id, role: "assistant", content: dataAnswerReply } });
          await recordGenesisExecution({
            action: EXECUTION_ACTIONS.GENESIS_STORE_MESSAGE,
            status: "SUCCESS",
            verified: false,
            message: dataAnswerReply,
            retryable: false,
            userId,
            storeId: store.id,
            metadata: { kind: "data_question" },
          });
          diagLog(requestId, turnStartedAt, "db_write_done", { kind: "data_question" });
          // No trailing token emit here — the reply was already streamed
          // live above via onTextDelta; emitting it again would duplicate
          // the text in the UI.
          emit({ type: "done", changes: null });
          diagLog(requestId, turnStartedAt, "stream_done_emitted", { kind: "data_question" });
          await logStreamedChatTurn({ userId, storeId: store.id, durationMs: Date.now() - turnStartedAt, outcome: "success", likelyRephraseOf, kind: "data_question" });
          controller.close();
          diagLog(requestId, turnStartedAt, "controller_closed", { kind: "data_question" });
          return;
        }

        if (chosenTool?.name === "capture_business_fact") {
          diagLog(requestId, turnStartedAt, "tool_selected", { tool: "capture_business_fact" });
          emit({ type: "status", text: "Got it — recording that…" });
          const input = chosenTool.input as BusinessFactCaptureInput;
          const entityType = input.entityType;
          const todayIso = new Date().toISOString().slice(0, 10);
          const fullData =
            entityType === "goal"
              ? toGoalRecordData(input.data, todayIso)
              : entityType === "challenge"
                ? toChallengeRecordData(input.data, todayIso)
                : entityType === "employee"
                  ? { ...input.data, status: "active", locationId: null }
                  : input.data;
          const parsed = ENTITY_REGISTRY[entityType].schema.safeParse(fullData);
          if (!parsed.success) {
            emit({ type: "fallback" });
            controller.close();
            return;
          }
          const { changes } = await persistSyncedRecords(store.id, "genesis_chat", [
            { entityType, externalId: randomUUID(), data: parsed.data },
          ]);
          if (entityType === "challenge" && changes[0]) {
            const challengeData = parsed.data as { severity: string | null; status: string; description: string };
            const recordId = changes[0].recordId;
            const topicKey = `challenge:${recordId}`;
            if (challengeData.severity === "high" && challengeData.status === "active") {
              const alreadyActive = await prisma.cognitiveOutput.findFirst({
                where: { storeId: store.id, topicKey, status: "ACTIVE" },
                select: { id: true },
              });
              const { communicateFinding } = await import("@/lib/execution/genesisAutonomy");
              const { upsertObservation } = await import("@/lib/dashboard/genesisObservations");
              if (!alreadyActive) {
                await communicateFinding(store.id, {
                  kind: "insight",
                  summary: challengeData.description,
                  priority: "high",
                  topicKey,
                  recordId,
                  entityType: "challenge",
                });
              }
              await upsertObservation(store.id, {
                dedupeKey: topicKey,
                genesisState: "urgent",
                summary: challengeData.description,
                actionHref: null,
                recordId,
                entityType: "challenge",
              });
            } else {
              const { resolveMissingObservations } = await import("@/lib/dashboard/genesisObservations");
              await resolveMissingObservations(store.id, [], "urgent", topicKey);
              await prisma.cognitiveOutput.updateMany({
                where: { storeId: store.id, topicKey, status: "ACTIVE" },
                data: { status: "RESOLVED", resolvedAt: new Date() },
              });
            }
          }
          const reply = conversationalReply || "Got it — I'll remember that about your business.";
          await prisma.storeMessage.create({ data: { storeId: store.id, role: "user", content: userMessage } });
          await prisma.storeMessage.create({ data: { storeId: store.id, role: "assistant", content: reply } });
          await recordGenesisExecution({
            action: EXECUTION_ACTIONS.GENESIS_STORE_MESSAGE,
            status: "SUCCESS",
            verified: false,
            message: reply,
            retryable: false,
            userId,
            storeId: store.id,
            metadata: { kind: "business_fact", entityType },
          });
          if (!streamedAnyText) emit({ type: "token", delta: reply });
          emit({ type: "done", changes: null });
          await logStreamedChatTurn({ userId, storeId: store.id, durationMs: Date.now() - turnStartedAt, outcome: "success", likelyRephraseOf, kind: "business_fact" });
          controller.close();
          return;
        }

        if (chosenTool?.name === "plan_campaign") {
          diagLog(requestId, turnStartedAt, "tool_selected", { tool: "plan_campaign" });
          emit({ type: "status", text: "Planning your campaign…" });
          const planned = await planMarketingCampaign(store.id, userMessage);
          const reply = planned
            ? `I've planned "${planned.name}" — ${planned.channels.length} channel${planned.channels.length === 1 ? "" : "s"}: ${planned.channels.map((c) => c.channel).join(", ")}. Take a look and let me know what you'd like to adjust before we schedule it.`
            : "I wasn't able to put a real campaign plan together from that — tell me a bit more about what you're promoting and I'll try again.";
          await prisma.storeMessage.create({ data: { storeId: store.id, role: "user", content: userMessage } });
          await prisma.storeMessage.create({ data: { storeId: store.id, role: "assistant", content: reply } });
          await recordGenesisExecution({
            action: EXECUTION_ACTIONS.GENESIS_STORE_MESSAGE,
            status: "SUCCESS",
            verified: false,
            message: reply,
            retryable: false,
            userId,
            storeId: store.id,
            metadata: { kind: "campaign_request", groupId: planned?.groupId ?? null },
          });
          emit({ type: "token", delta: reply });
          emit({ type: "done", changes: null });
          await logStreamedChatTurn({ userId, storeId: store.id, durationMs: Date.now() - turnStartedAt, outcome: "success", likelyRephraseOf, kind: "campaign_request" });
          controller.close();
          return;
        }

        if (chosenTool?.name === "request_image_change") {
          diagLog(requestId, turnStartedAt, "tool_selected", { tool: "request_image_change" });
          emit({ type: "status", text: "Finding new photos…" });
          const input = chosenTool.input as RequestImageChangeInput;
          const targetProducts =
            input.scope === "all"
              ? currentProducts
              : input.scope === "specific"
                ? currentProducts.filter((p) =>
                    (input.productNames ?? []).map((n) => n.trim().toLowerCase()).includes(p.name.trim().toLowerCase())
                  )
                : [];

          if (targetProducts.length === 0) {
            const clarification =
              input.scope === "specific"
                ? `I want to make sure I update the right one — which product did you mean? Your active products are: ${currentProducts.map((p) => p.name).join(", ")}.`
                : conversationalReply || "Which product would you like a new photo for?";
            await prisma.storeMessage.create({ data: { storeId: store.id, role: "user", content: userMessage } });
            await prisma.storeMessage.create({ data: { storeId: store.id, role: "assistant", content: clarification } });
            if (!streamedAnyText) emit({ type: "token", delta: clarification });
            emit({ type: "done", changes: null });
            await logStreamedChatTurn({ userId, storeId: store.id, durationMs: Date.now() - turnStartedAt, outcome: "failure", likelyRephraseOf, kind: "image_request" });
            controller.close();
            return;
          }

          const groupId = randomUUID();
          const outcomes: { id: string; name: string; candidate: string | null }[] = [];
          for (const product of targetProducts) {
            const sourced = await resolveProductImage({
              prompt: extractRichContentImagePrompt(product.richContent) ?? product.description ?? product.name,
              name: product.name,
              description: product.description,
              excludeUrls: product.imageUrl ? [product.imageUrl] : [],
              scope: { storeId: store.id },
              feature: "product_image_generation",
            });
            const candidate = sourced?.url ?? null;
            if (candidate) {
              await prisma.approvalRequest.deleteMany({
                where: {
                  storeId: store.id,
                  actionType: "update_product_image",
                  status: "PENDING_APPROVAL",
                  input: { path: ["productId"], equals: product.id },
                },
              });
              await prisma.approvalRequest.create({
                data: {
                  storeId: store.id,
                  recommendationId: null,
                  actionType: "update_product_image",
                  input: {
                    productId: product.id,
                    imageUrl: candidate,
                    ...(sourced?.generationPrompt ? { generationPrompt: sourced.generationPrompt } : {}),
                  },
                  previousValues: { productId: product.id, imageUrl: product.imageUrl, rejectedCandidates: [] },
                  summary: `Replace image for "${product.name}"`,
                  authorizationTier: GENESIS_ACTIONS.update_product_image.authorizationTier,
                  groupId,
                  aiUsageEventId: sourced?.aiUsageEventId ?? null,
                },
              });
            }
            outcomes.push({ id: product.id, name: product.name, candidate });
          }

          const foundNames = outcomes.filter((o) => o.candidate).map((o) => o.name);
          const missedNames = outcomes.filter((o) => !o.candidate).map((o) => o.name);
          const replyParts = [conversationalReply || "I'm looking for new photos now."];
          if (foundNames.length > 1) {
            replyParts.push(`These are grouped as one idea on Products — review each, or use "Use all ${foundNames.length}" to apply them together.`);
          } else if (foundNames.length === 1) {
            replyParts.push(`You'll find it waiting for your review on Products.`);
          }
          if (missedNames.length > 0) {
            replyParts.push(`I couldn't find a good option for ${missedNames.join(", ")} — you may want to upload ${missedNames.length > 1 ? "those" : "that one"} directly for now.`);
          }
          const finalReply = replyParts.join(" ");
          await prisma.storeMessage.create({ data: { storeId: store.id, role: "user", content: userMessage } });
          await prisma.storeMessage.create({ data: { storeId: store.id, role: "assistant", content: finalReply } });
          await recordGenesisExecution({
            action: EXECUTION_ACTIONS.GENESIS_STORE_MESSAGE,
            status: foundNames.length > 0 ? "PENDING" : "WARNING",
            verified: false,
            message: foundNames.length > 0 ? `Proposed new images for ${foundNames.join(", ")}` : `Couldn't find new images for ${missedNames.join(", ")}`,
            retryable: foundNames.length === 0,
            userId,
            storeId: store.id,
            metadata: { groupId, productIds: outcomes.filter((o) => o.candidate).map((o) => o.id) },
          });
          // The deterministic trailer (grouping/miss notes) wasn't part of
          // the live-streamed text, so it's appended as one more token
          // event rather than silently only living in the DB row.
          emit({ type: "token", delta: finalReply.slice((conversationalReply || "").length) });
          emit({ type: "done", changes: null });
          await logStreamedChatTurn({ userId, storeId: store.id, durationMs: Date.now() - turnStartedAt, outcome: foundNames.length > 0 ? "success" : "failure", likelyRephraseOf, kind: "image_request" });
          controller.close();
          return;
        }

        // edit_store_content, or the model didn't call a tool and didn't
        // produce usable text — both fall back to the existing, unchanged,
        // already-working Server Action. Nothing was persisted for this
        // turn yet, so the fallback's own user-message write is the only
        // one that happens — no duplicate.
        diagLog(requestId, turnStartedAt, "fallback_emitted", { reason: "no_tool_no_text_or_edit_store_content" });
        emit({ type: "fallback" });
        controller.close();
        diagLog(requestId, turnStartedAt, "controller_closed", { kind: "fallback" });
      } catch (err) {
        diagLog(requestId, turnStartedAt, "route_error", {
          message: err instanceof Error ? err.message : String(err),
          name: err instanceof Error ? err.name : undefined,
        });
        console.error("[genesis-chat-stream-error]", err);
        try {
          emit({ type: "fallback" });
        } catch {
          // controller may already be closed/errored — nothing more to do.
        }
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" },
  });
}
