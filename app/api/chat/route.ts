import { randomUUID } from "crypto";
import { withJ4CopyRules } from "@/lib/j4CopyRules";
import type { Theme } from "@/lib/theme";
import type { RefineStorefrontInput } from "@/lib/execution/executables/refineStorefront";
import { auth } from "@/auth";
import { revalidatePath } from "next/cache";
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
import { describeWorkspaceForJ4 } from "@/lib/j4/workspaceContext";
import {
  getOpenProposal,
  reviseProposal,
  openProposal as openProposalRecord,
  type ProposalDirection,
} from "@/lib/storefront/proposals";
import { RefineStorefrontToolInputSchema } from "@/lib/execution/genesisTools";
import { GenerateBrandLogoInputSchema } from "@/lib/execution/genesisTools";
import { CreateDesignInputSchema } from "@/lib/execution/genesisTools";
import { ApproveDesignAsProductInputSchema } from "@/lib/execution/genesisTools";
import { execute } from "@/lib/execution/engine";
import { createProductFromDesignExecutable } from "@/lib/execution/executables/productFromDesign";
import { createDesign } from "@/lib/design/createDesign";
import { getSurface } from "@/lib/design/surfaces";
import { ASSET_ROLES, designateAsset, resolveCurrentAsset } from "@/lib/businessModel/assets";
import { AssetSchema } from "@/lib/businessModel/entities";
import { branchBrandLogo, hasExistingLogo, proposeBrandLogo } from "@/lib/brand/proposeBrandLogo";
import { planMarketingCampaign } from "@/lib/marketing/campaigns";
import { resolveProductImage } from "@/lib/imageProviders/resolveProductImage";
import { generateProductContentChanges } from "@/lib/execution/productContentGeneration";
import { resolveMostRecentPendingApprovalBatch, describeApprovalExecutionForChat } from "@/lib/dashboard/pendingApprovals";
import { performApprovePendingChanges } from "@/app/dashboard/ai-actions";
import {
  buildStoreChatUnifiedTools,
  firstToolUse,
  textOf,
  type BusinessFactCaptureInput,
  type RequestImageChangeInput,
  type RequestProductRemovalInput,
  type RequestProductContentChangeInput,
  type ManageBusinessAssetInput,
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
  // reason is optional and only ever "edit_store_content" today — see the
  // one real emit site below for why (J4 command execution fix,
  // 2026-08-08). Every other fallback (provider failure, unresolved
  // classification) omits it, preserving today's exact client behavior.
  | { type: "fallback"; reason?: "edit_store_content" }
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
    | { message?: string; requestId?: string; audioUrl?: string; workspacePath?: string }
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

  // 2026-08-08 — voice-memo streaming convergence: a transcribed memo is
  // real conversational text, submitted through this exact same endpoint a
  // typed message uses (see uploadVoiceMemo's own comment on why it no
  // longer drives the reply itself). The one real difference is this
  // turn's user StoreMessage should carry the same {audioUrl} shape it
  // always has, so the conversation still renders it as a playable memo,
  // not silently as plain text. Undefined (the default) preserves every
  // existing typed-message write byte-for-byte.
  const userMessageChanges = body?.audioUrl ? { audioUrl: body.audioUrl } : undefined;

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

      // "explicit work states... visibly communicate that J4 is working"
      // (Sean, 2026-08-08, after a real test read the old static
      // "thinking" line as "no answer"). The client already shows its own
      // optimistic "received" text the instant the form submits (before
      // any network round trip); this is the first SERVER-confirmed
      // stage, sent before any real work (the DB read below can take a
      // moment on a busy conversation) so the transition from "the
      // browser thinks it sent this" to "J4 actually has it" happens as
      // early as honestly possible.
      emit({ type: "status", text: "J4 received your message — understanding what you need…" });
      diagLog(requestId, turnStartedAt, "status_received_emitted");

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
          await prisma.storeMessage.create({ data: { storeId: store.id, role: "user", content: userMessage, changes: userMessageChanges } });
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
          await prisma.storeMessage.create({ data: { storeId: store.id, role: "user", content: userMessage, changes: userMessageChanges } });
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
        // What the owner is looking at while asking (2026-08-14). J4 opens
        // over the workspace now rather than replacing it, so "make this
        // bolder" is a complete sentence — but only if J4 is told what
        // "this" is. Resolved through a closed registry
        // (lib/j4/workspaceContext.ts): an unrecognised path adds nothing,
        // and the browser's own string never reaches the prompt.
        const workspaceLine = describeWorkspaceForJ4(body?.workspacePath);
        if (workspaceLine) {
          unifiedContextParts.push(workspaceLine);
        }
        // The proposal currently on the table, if any (2026-08-14). Without
        // this, J4 answers "I don't like that, keep it handmade" as though it
        // were a brand new request, having no idea there is a specific
        // proposal being argued with. The revision itself is decided in code
        // from the target, not here — this exists so J4's own words are those
        // of someone revising their own idea rather than proposing a fresh
        // one at a person who just pushed back.
        const proposalOnTable = await getOpenProposal(store.id);
        if (proposalOnTable && !proposalOnTable.settled) {
          const c = proposalOnTable.current;
          unifiedContextParts.push(
            `(You have a proposal on the table right now, version ${c.revision}, which the merchant can see below this conversation: "${c.summary}"${
              c.rationale ? ` Your reasoning was: "${c.rationale}"` : ""
            } If they are pushing back on it, refine THIS proposal rather than starting a new one: call refine_storefront again for the same target ("${c.target ?? "the storefront"}") with the change they asked for, and speak as someone improving their own idea, not proposing a new one.)`
          );
        }
        if (pending) {
          unifiedContextParts.push(`(You previously proposed this change, awaiting confirmation: "${pending.summary}")`);
        }
        // J4 conversational approval (2026-08-09) — real evidence this was
        // missing: Sean said "I approve all together, make the change" and
        // the model, with no signal that anything was actually pending,
        // called request_product_content_change again instead of executing
        // what it had just proposed. This is the model's only way to know
        // there's something real to authorize, distinct from pendingChange
        // above (that's the lighter, non-ApprovalRequest confirmation loop
        // edit_store_content uses; this is the real, structured, groupId-
        // backed proposal system every other tool here writes into).
        const pendingApprovalBatch = await resolveMostRecentPendingApprovalBatch(store.id);
        if (pendingApprovalBatch) {
          unifiedContextParts.push(
            `(Awaiting your decision — ${pendingApprovalBatch.summaries.length} change${pendingApprovalBatch.summaries.length === 1 ? "" : "s"} you already proposed: ${pendingApprovalBatch.summaries.map((s) => `"${s}"`).join(", ")}. If the merchant now clearly authorizes you to proceed with these, call approve_pending_changes.)`
          );
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

        // Real next stage, distinct from the earlier "received" status —
        // upload-intent classification (above) has already run; this is
        // J4 actually reasoning about the request, not just acknowledging
        // it.
        emit({ type: "status", text: "Working on your request…" });
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
        // Real production investigation (2026-08-08) — Sean's real iPhone
        // test still shows the complete response appearing in one paste
        // despite the server-side padding fix, disconnect-safe
        // persistence, and the schema fix that finally let this call
        // succeed at all. Per-delta logging (every one, not just the
        // first) is the only way to tell "Anthropic is genuinely sending
        // many small deltas" from "one big delta arrived" — the two look
        // identical from firstTokenAtMs alone. Temporary, deleted once
        // the real bottleneck layer is found.
        let deltaIndex = 0;
        const unifiedOutcome = await callGenesisModel(
          {
            model: "claude-opus-4-8",
            max_tokens: 1500,
            thinking: { type: "adaptive" },
            system: [
              {
                type: "text",
                text: withJ4CopyRules(STORE_CHAT_UNIFIED_SYSTEM_PROMPT),
                cache_control: { type: "ephemeral" },
              },
            ],
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
              }
              deltaIndex += 1;
              diagLog(requestId, turnStartedAt, "unified_delta", { i: deltaIndex, len: delta.length });
              streamedAnyText = true;
              emit({ type: "token", delta });
            },
          }
        );
        diagLog(requestId, turnStartedAt, "unified_delta_summary", { totalDeltas: deltaIndex, firstTokenAtMs });
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
          await prisma.storeMessage.create({ data: { storeId: store.id, role: "user", content: userMessage, changes: userMessageChanges } });
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
          let dataAnswerDeltaIndex = 0;
          diagLog(requestId, turnStartedAt, "data_answer_call_started");
          const answerOutcome = await callGenesisModel(
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
                }
                dataAnswerDeltaIndex += 1;
                diagLog(requestId, turnStartedAt, "data_answer_delta", { i: dataAnswerDeltaIndex, len: delta.length });
                streamedAnyText = true;
                dataAnswerReply += delta;
                emit({ type: "token", delta });
              },
            }
          );
          diagLog(requestId, turnStartedAt, "data_answer_delta_summary", { totalDeltas: dataAnswerDeltaIndex, firstTokenAtMs });
          diagLog(requestId, turnStartedAt, "data_answer_call_finished", { ok: answerOutcome.ok, replyLength: dataAnswerReply.length });
          if (!answerOutcome.ok || !dataAnswerReply) {
            diagLog(requestId, turnStartedAt, "data_answer_failed");
            emit({ type: "error", message: genesisModelFailureMessage(answerOutcome.ok ? "unknown" : answerOutcome.kind) });
            controller.close();
            return;
          }
          diagLog(requestId, turnStartedAt, "db_write_start", { kind: "data_question" });
          await prisma.storeMessage.create({ data: { storeId: store.id, role: "user", content: userMessage, changes: userMessageChanges } });
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
          await prisma.storeMessage.create({ data: { storeId: store.id, role: "user", content: userMessage, changes: userMessageChanges } });
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
          await prisma.storeMessage.create({ data: { storeId: store.id, role: "user", content: userMessage, changes: userMessageChanges } });
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
            await prisma.storeMessage.create({ data: { storeId: store.id, role: "user", content: userMessage, changes: userMessageChanges } });
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
          await prisma.storeMessage.create({ data: { storeId: store.id, role: "user", content: userMessage, changes: userMessageChanges } });
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

        // 2026-08-08 — the real missing capability: J4 previously had no
        // way to remove a product at all and told the owner to do it
        // manually. This never executes the deletion itself (delete_product
        // is a hard-locked "destructive" category action — see
        // genesisActions.ts's CATEGORY_MAX_TIER) — it proposes one
        // ApprovalRequest per resolved product, same shape as
        // request_image_change above, and the owner's real confirmation is
        // the existing Approve action on Products, not a second bespoke
        // confirmation UI.
        if (chosenTool?.name === "request_product_removal") {
          diagLog(requestId, turnStartedAt, "tool_selected", { tool: "request_product_removal" });
          const input = chosenTool.input as RequestProductRemovalInput;
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
                ? `I want to make sure I remove the right one — which product did you mean? Your active products are: ${currentProducts.map((p) => p.name).join(", ")}.`
                : conversationalReply || "Which product would you like me to remove?";
            await prisma.storeMessage.create({ data: { storeId: store.id, role: "user", content: userMessage, changes: userMessageChanges } });
            await prisma.storeMessage.create({ data: { storeId: store.id, role: "assistant", content: clarification } });
            if (!streamedAnyText) emit({ type: "token", delta: clarification });
            emit({ type: "done", changes: null });
            await logStreamedChatTurn({ userId, storeId: store.id, durationMs: Date.now() - turnStartedAt, outcome: "failure", likelyRephraseOf, kind: "product_removal_request" });
            controller.close();
            return;
          }

          const groupId = randomUUID();
          for (const product of targetProducts) {
            // A fresh proposal supersedes any earlier still-pending one for
            // the same product, same dedupe rule request_image_change's own
            // loop already follows above.
            await prisma.approvalRequest.deleteMany({
              where: {
                storeId: store.id,
                actionType: "delete_product",
                status: "PENDING_APPROVAL",
                input: { path: ["productId"], equals: product.id },
              },
            });
            await prisma.approvalRequest.create({
              data: {
                storeId: store.id,
                recommendationId: null,
                actionType: "delete_product",
                input: { productId: product.id, name: product.name },
                previousValues: { productId: product.id, name: product.name },
                summary: `Remove "${product.name}" — this permanently deletes it`,
                authorizationTier: GENESIS_ACTIONS.delete_product.authorizationTier,
                groupId,
              },
            });
          }

          const names = targetProducts.map((p) => p.name);
          const replyParts = [
            conversationalReply ||
              (names.length > 1
                ? `I've proposed removing ${names.length} products: ${names.join(", ")}.`
                : `I've proposed removing "${names[0]}".`),
          ];
          replyParts.push(
            names.length > 1
              ? `These are grouped as one idea on Products — review and approve each to permanently delete them.`
              : `You'll find it waiting for your review on Products — approve it to permanently delete it.`
          );
          const finalReply = replyParts.join(" ");
          await prisma.storeMessage.create({ data: { storeId: store.id, role: "user", content: userMessage, changes: userMessageChanges } });
          await prisma.storeMessage.create({ data: { storeId: store.id, role: "assistant", content: finalReply } });
          await recordGenesisExecution({
            action: EXECUTION_ACTIONS.GENESIS_STORE_MESSAGE,
            status: "PENDING",
            verified: false,
            message: `Proposed removing ${names.join(", ")}`,
            retryable: false,
            userId,
            storeId: store.id,
            metadata: { groupId, productIds: targetProducts.map((p) => p.id) },
          });
          emit({ type: "token", delta: finalReply.slice((conversationalReply || "").length) });
          emit({ type: "done", changes: null });
          await logStreamedChatTurn({ userId, storeId: store.id, durationMs: Date.now() - turnStartedAt, outcome: "success", likelyRephraseOf, kind: "product_removal_request" });
          controller.close();
          return;
        }

        // Storefront Canvas, step 3 reachability (2026-08-12) — the merchant
        // asking for one small structural or presentational improvement.
        //
        // Its own fast path, exactly like request_image_change and
        // request_product_removal above and for the same stated reason: this
        // is a discrete, enum-bounded change, so it never needs the PRIMARY
        // content pipeline that edit_store_content falls back to.
        //
        // This bridge only PROPOSES. Execution, verification, Growth Point
        // charging and the Business Partner waiver all happen later, on the
        // owner's own approval, through the unchanged engine path.
        // "Make me a logo" (2026-08-16). The conversational entry point to
        // the brand-logo slice — see WORK_STUDIO.md for the chain this sits at
        // the head of: Asset -> Design -> Product -> Provider.
        //
        // Deliberately does NOT delete a prior pending proposal, unlike
        // request_image_change above. Creative work depends on siblings
        // coexisting: an owner who liked the first logo must still have it
        // when alternatives appear, and "keep the symbol from the original"
        // needs the original to still exist.
        // "Put my logo on a T-shirt" (2026-08-16). The conversational entry
        // to the Design layer — asset(s) + surface + arrangement -> print file
        // + mockup (lib/design/). J4 resolves the approved asset itself rather
        // than asking the owner to find and upload it again, which is the
        // whole difference between a partner and a design tool.
        // The end of the Studio chain (2026-08-17): approval with a real
        // consequence. The owner says yes to a mockup they are looking at and
        // a product appears in their storefront.
        //
        // Executed directly rather than raised as another ApprovalRequest.
        // The confirmation ladder is explicit that an owner who just approved
        // something in words, while looking straight at it, must not be asked
        // to approve it again — a second confirmation here would be the
        // product asking "are you sure" about the sentence they just said.
        if (chosenTool?.name === "approve_design_as_product") {
          diagLog(requestId, turnStartedAt, "tool_selected", { tool: "approve_design_as_product" });
          const parsedApproval = ApproveDesignAsProductInputSchema.safeParse(chosenTool.input);

          // The design they are responding to is the most recent one in this
          // store. Deliberately not asked for by id: the owner is saying "yes"
          // to the thing on screen, and making the model carry an id through
          // the conversation is a way for it to get the wrong one.
          const latestDesign = await prisma.businessRecord.findFirst({
            where: { storeId: store.id, entityType: "design" },
            orderBy: { syncedAt: "desc" },
            select: { id: true },
          });

          if (!parsedApproval.success || !latestDesign) {
            const reply =
              conversationalReply ||
              "I don't have a design on the table to add. Ask me to make something first and I'll put it in front of you.";
            await prisma.storeMessage.create({ data: { storeId: store.id, role: "user", content: userMessage, changes: userMessageChanges } });
            await prisma.storeMessage.create({ data: { storeId: store.id, role: "assistant", content: reply } });
            if (!streamedAnyText) emit({ type: "token", delta: reply });
            emit({ type: "done", changes: null });
            await logStreamedChatTurn({ userId, storeId: store.id, durationMs: Date.now() - turnStartedAt, outcome: "failure", likelyRephraseOf, kind: "approve_design_as_product" });
            controller.close();
            return;
          }

          // Through the engine, so this is a recorded, verified execution like
          // every other real change — not a bare prisma write in a chat route.
          const result = await execute(createProductFromDesignExecutable, {
            designId: latestDesign.id,
            name: parsedApproval.data.name,
            priceInCents: parsedApproval.data.priceInCents,
            ...(parsedApproval.data.description ? { description: parsedApproval.data.description } : {}),
          });

          // execute() never throws for a failure inside run(); it returns a
          // FAILED result. Discarding it would tell the owner their product
          // exists when it does not.
          const succeeded = result.status === "SUCCESS";
          if (succeeded) {
            // The product is real now, so every surface that lists products
            // has to stop serving a cached page that predates it.
            revalidatePath("/dashboard/studio");
            revalidatePath("/dashboard/products");
            revalidatePath("/dashboard/orders");
          }
          const reply = succeeded
            ? `${conversationalReply || `Done — "${parsedApproval.data.name}" is in your store now.`} You'll find it under Commerce, and it's live on your storefront.`
            : conversationalReply ||
              "I couldn't add that to your store just then. Nothing has changed — try me again in a moment.";

          await prisma.storeMessage.create({ data: { storeId: store.id, role: "user", content: userMessage, changes: userMessageChanges } });
          await prisma.storeMessage.create({ data: { storeId: store.id, role: "assistant", content: reply } });
          emit({ type: "token", delta: reply.slice((conversationalReply || "").length) });
          emit({ type: "done", changes: null });
          await logStreamedChatTurn({ userId, storeId: store.id, durationMs: Date.now() - turnStartedAt, outcome: succeeded ? "success" : "failure", likelyRephraseOf, kind: "approve_design_as_product" });
          controller.close();
          return;
        }

        if (chosenTool?.name === "create_design") {
          diagLog(requestId, turnStartedAt, "tool_selected", { tool: "create_design" });
          const parsedDesign = CreateDesignInputSchema.safeParse(chosenTool.input);
          const surfaceKey = parsedDesign.success ? parsedDesign.data.surface : null;
          const surface = surfaceKey ? getSurface(surfaceKey) : null;

          // The asset has to already exist and be approved. J4 never invents
          // artwork here — if there is no designated logo, say so plainly and
          // OFFER to make one rather than making one uninvited. That offer is
          // the no-pressure rule: it is a sentence the owner can ignore.
          const logo = surface ? await resolveCurrentAsset(store.id, ASSET_ROLES.brandLogo) : null;
          if (!surface || !logo) {
            const reply = !surface
              ? conversationalReply || "I can put your logo on a t-shirt or a hoodie. Which one did you have in mind?"
              : conversationalReply ||
                "You don't have a logo saved yet, so there's nothing for me to put on it. I can make one based on what I know about your business if you want.";
            await prisma.storeMessage.create({ data: { storeId: store.id, role: "user", content: userMessage, changes: userMessageChanges } });
            await prisma.storeMessage.create({ data: { storeId: store.id, role: "assistant", content: reply } });
            if (!streamedAnyText) emit({ type: "token", delta: reply });
            emit({ type: "done", changes: null });
            await logStreamedChatTurn({ userId, storeId: store.id, durationMs: Date.now() - turnStartedAt, outcome: "failure", likelyRephraseOf, kind: "create_design" });
            controller.close();
            return;
          }

          const design = await createDesign({
            storeId: store.id,
            assetIds: [logo.id],
            surface: surface.key,
          });
          if (!design) {
            const reply = conversationalReply || "I couldn't put that together just now. Try me again in a moment.";
            await prisma.storeMessage.create({ data: { storeId: store.id, role: "user", content: userMessage, changes: userMessageChanges } });
            await prisma.storeMessage.create({ data: { storeId: store.id, role: "assistant", content: reply } });
            if (!streamedAnyText) emit({ type: "token", delta: reply });
            emit({ type: "done", changes: null });
            await logStreamedChatTurn({ userId, storeId: store.id, durationMs: Date.now() - turnStartedAt, outcome: "failure", likelyRephraseOf, kind: "create_design" });
            controller.close();
            return;
          }

          // Studio shows the work (2026-08-17). Without this the bench still
          // reads "nothing on the bench yet" after J4 has just made something,
          // because the page is cached from before it existed. Office keeps
          // the record either way; Studio is where it has to be VISIBLE.
          revalidatePath("/dashboard/studio");

          const finalReply = [
            conversationalReply || `Here's your logo on a ${surface.label.toLowerCase()}.`,
            "That's your real mark composited onto it, not an impression of it, and the print file is ready at full size. Tell me if you want it bigger, smaller, or somewhere else on the garment.",
          ].join(" ");

          await prisma.storeMessage.create({ data: { storeId: store.id, role: "user", content: userMessage, changes: userMessageChanges } });
          await prisma.storeMessage.create({
            data: {
              storeId: store.id,
              role: "assistant",
              content: finalReply,
              // The mockup rides in `changes` so the conversation renders it
              // inline, the same channel a product image proposal already uses.
              changes: { imageUrl: design.mockupUrl, designId: design.designId, surface: surface.key },
            },
          });
          await recordGenesisExecution({
            action: EXECUTION_ACTIONS.GENESIS_STORE_MESSAGE,
            status: "PENDING",
            verified: false,
            message: `Composed a design on ${surface.label}`,
            retryable: false,
            userId,
            storeId: store.id,
            metadata: { designId: design.designId, surface: surface.key, assetIds: [logo.id] },
          });
          emit({ type: "token", delta: finalReply.slice((conversationalReply || "").length) });
          emit({ type: "done", changes: null });
          await logStreamedChatTurn({ userId, storeId: store.id, durationMs: Date.now() - turnStartedAt, outcome: "success", likelyRephraseOf, kind: "create_design" });
          controller.close();
          return;
        }

        if (chosenTool?.name === "generate_brand_logo") {
          diagLog(requestId, turnStartedAt, "tool_selected", { tool: "generate_brand_logo" });
          const parsedLogo = GenerateBrandLogoInputSchema.safeParse(chosenTool.input);
          const ownerDirection = parsedLogo.success ? parsedLogo.data.ownerDirection : null;
          const wantsAlternatives = parsedLogo.success ? parsedLogo.data.wantsAlternatives : false;

          // THE NO-PRESSURE RULE, enforced here rather than trusted to the
          // prompt. An owner who already has a logo is finished; J4 being able
          // to make another is not a reason to raise it. The only thing that
          // overrides this is the owner explicitly asking, which is what
          // ownerDirection carries.
          const alreadyHasLogo = await hasExistingLogo(store.id);
          if (alreadyHasLogo && !ownerDirection) {
            const reply =
              conversationalReply ||
              "You've already got a logo, and it's yours — I'll work with that one. If you ever want a different direction, say so and I'll put something together.";
            await prisma.storeMessage.create({ data: { storeId: store.id, role: "user", content: userMessage, changes: userMessageChanges } });
            await prisma.storeMessage.create({ data: { storeId: store.id, role: "assistant", content: reply } });
            if (!streamedAnyText) emit({ type: "token", delta: reply });
            emit({ type: "done", changes: null });
            await logStreamedChatTurn({ userId, storeId: store.id, durationMs: Date.now() - turnStartedAt, outcome: "success", likelyRephraseOf, kind: "generate_brand_logo" });
            controller.close();
            return;
          }

          const proposed = await proposeBrandLogo({ storeId: store.id, ownerDirection });
          if (!proposed) {
            // Honest failure, the convention every image path here follows: no
            // logo was made, and no placeholder is invented to cover it.
            const reply =
              conversationalReply ||
              "I couldn't get a logo generated just then. Try me again in a moment.";
            await prisma.storeMessage.create({ data: { storeId: store.id, role: "user", content: userMessage, changes: userMessageChanges } });
            await prisma.storeMessage.create({ data: { storeId: store.id, role: "assistant", content: reply } });
            if (!streamedAnyText) emit({ type: "token", delta: reply });
            emit({ type: "done", changes: null });
            await logStreamedChatTurn({ userId, storeId: store.id, durationMs: Date.now() - turnStartedAt, outcome: "failure", likelyRephraseOf, kind: "generate_brand_logo" });
            controller.close();
            return;
          }

          // Alternatives ONLY when the owner actually asked. Never automatic —
          // an offer that always fires is not an offer. Siblings, so the
          // original survives.
          let alternativeCount = 0;
          if (wantsAlternatives) {
            const lineage = await branchBrandLogo({
              storeId: store.id,
              proposalId: proposed.proposal.proposalId,
              ownerDirection,
              alternatives: [
                { label: "Warmer and simpler", intent: "Softer, friendlier, fewer elements. Warmth over polish." },
                { label: "Bolder and more graphic", intent: "Higher contrast, a stronger single shape, more confident." },
              ],
            });
            alternativeCount = lineage?.branches.length ?? 0;
          }

          const finalReply = [
            conversationalReply || proposed.rationale,
            alternativeCount > 0
              ? "I've put a couple of other directions beside it. The first one's still there — tell me which way you want to go, or take pieces from more than one."
              : "Have a look below. Tell me what you'd change, or if you're not sure yet I can show you a couple of other directions.",
          ].join(" ");

          await prisma.storeMessage.create({ data: { storeId: store.id, role: "user", content: userMessage, changes: userMessageChanges } });
          await prisma.storeMessage.create({ data: { storeId: store.id, role: "assistant", content: finalReply } });
          await recordGenesisExecution({
            action: EXECUTION_ACTIONS.GENESIS_STORE_MESSAGE,
            status: "PENDING",
            verified: false,
            message: "Proposed a brand logo",
            retryable: false,
            userId,
            storeId: store.id,
            metadata: {
              groundedIn: proposed.groundedIn,
              ownerDirection,
              alternatives: alternativeCount,
            },
          });
          emit({ type: "token", delta: finalReply.slice((conversationalReply || "").length) });
          emit({ type: "done", changes: null });
          await logStreamedChatTurn({ userId, storeId: store.id, durationMs: Date.now() - turnStartedAt, outcome: "success", likelyRephraseOf, kind: "generate_brand_logo" });
          controller.close();
          return;
        }

        if (chosenTool?.name === "refine_storefront") {
          diagLog(requestId, turnStartedAt, "tool_selected", { tool: "refine_storefront" });

          // Validated against the ACTION's own schema, not the tool's. The
          // tool schema guides the model; this is the boundary that decides
          // whether a real ApprovalRequest gets written.
          const parsed = GENESIS_ACTIONS.refine_storefront.inputSchema.safeParse(chosenTool.input);
          if (!parsed.success) {
            const clarification =
              conversationalReply ||
              "I couldn't work out which part of your storefront you meant. Tell me which section and what feels off about it.";
            await prisma.storeMessage.create({ data: { storeId: store.id, role: "user", content: userMessage, changes: userMessageChanges } });
            await prisma.storeMessage.create({ data: { storeId: store.id, role: "assistant", content: clarification } });
            if (!streamedAnyText) emit({ type: "token", delta: clarification });
            emit({ type: "done", changes: null });
            await logStreamedChatTurn({ userId, storeId: store.id, durationMs: Date.now() - turnStartedAt, outcome: "failure", likelyRephraseOf, kind: "refine_storefront" });
            controller.close();
            return;
          }
          const refineInput = parsed.data as RefineStorefrontInput;

          // Directions, if J4 offered a real choice (2026-08-14).
          //
          // Read from the RAW tool call, not from parsed.data: the action
          // registry's inputSchema is the security boundary for what will be
          // EXECUTED, and it deliberately knows nothing about directions, so
          // it strips them. That separation is the point — approving a
          // proposal that offered a choice executes exactly the same shape as
          // one that did not, and the executable's contract is untouched.
          //
          // Validated on its own terms against the tool schema, so a
          // malformed or single-item directions array becomes no directions
          // rather than a broken chooser.
          const rawDirections = (chosenTool.input as { directions?: unknown })?.directions;
          const parsedDirections = RefineStorefrontToolInputSchema.shape.directions.safeParse(rawDirections);
          const offeredDirections: ProposalDirection[] =
            parsedDirections.success && parsedDirections.data
              ? parsedDirections.data.map((d, i) => ({
                  // Positional ids. The model is never asked to invent one,
                  // which is one less thing it can return inconsistently
                  // between the label it shows and the id a button submits.
                  id: `d${i + 1}`,
                  label: d.label,
                  rationale: d.reason,
                  changes: d.changes,
                }))
              : [];

          // The real stored theme, never the model's restatement of it —
          // the same rule every other getCurrentValues in the registry
          // follows, so the approval card diffs against ground truth.
          const themeRow = await prisma.store.findUnique({
            where: { id: store.id },
            select: { theme: true },
          });
          const previousValues = GENESIS_ACTIONS.refine_storefront.getCurrentValues({
            blueprint: null,
            theme: (themeRow?.theme as Theme | null) ?? null,
          });

          // A rebuttal revises the proposal already on the table; it does not
          // start a new one (2026-08-14). Sean's requirement, and the reason
          // this replaced a deleteMany: "if the owner disagrees with the first
          // idea, J4 should refine the same proposal rather than treating the
          // rebuttal as a new unrelated request."
          //
          // The old code already recognised "same target, still pending" as
          // the same subject — it just resolved it by deleting the earlier
          // row, which answered the rebuttal and destroyed the evidence of it
          // in one operation. An owner saying "go back to your first idea" was
          // talking about something that no longer existed.
          //
          // Same target plus an open proposal means revision, decided in code
          // rather than asked of the model. The model has no extra field to
          // get wrong, and a genuinely different target still opens its own
          // proposal, so a pending hero idea and a pending products idea
          // coexist exactly as before.
          const openProposal = await getOpenProposal(store.id);
          const isRevision =
            openProposal !== null &&
            openProposal.current.target === refineInput.target &&
            !openProposal.settled;

          if (isRevision) {
            await reviseProposal(store.id, openProposal.proposalId, {
              summary: refineInput.summary,
              rationale: refineInput.reason,
              target: refineInput.target,
              input: refineInput as unknown as Record<string, unknown>,
              directions: offeredDirections,
            });
          } else {
            await openProposalRecord(store.id, {
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

          // The proposal is rendered directly beneath this conversation, in
          // the same layer the owner is already reading — so it must never be
          // described as waiting somewhere else. The previous copy sent them
          // to the dashboard to find it, which is the exact trip the
          // persistent layer exists to remove.
          const finalReply = [
            conversationalReply || refineInput.summary,
            offeredDirections.length > 1
              ? "Have a look below. Flip between them and tell me which way you want to go."
              : isRevision
                ? "I've revised it below. Have a look and tell me if that's closer."
                : "Have a look below. Tell me what you think, or tell me to change it.",
          ].join(" ");
          await prisma.storeMessage.create({ data: { storeId: store.id, role: "user", content: userMessage, changes: userMessageChanges } });
          await prisma.storeMessage.create({ data: { storeId: store.id, role: "assistant", content: finalReply } });
          await recordGenesisExecution({
            action: EXECUTION_ACTIONS.GENESIS_STORE_MESSAGE,
            status: "PENDING",
            verified: false,
            message: `Proposed refining ${refineInput.target}`,
            retryable: false,
            userId,
            storeId: store.id,
            metadata: {
              target: refineInput.target,
              changes: refineInput.changes,
              reason: refineInput.reason,
            },
          });
          emit({ type: "token", delta: finalReply.slice((conversationalReply || "").length) });
          emit({ type: "done", changes: null });
          await logStreamedChatTurn({ userId, storeId: store.id, durationMs: Date.now() - turnStartedAt, outcome: "success", likelyRephraseOf, kind: "refine_storefront" });
          controller.close();
          return;
        }

        // J4 approvable product content changes (2026-08-09) — "if J4 can
        // perform the change, J4 should perform the change after I
        // approve it... product names, descriptions" (Sean, real feedback
        // after J4 told him to paste suggested names in by hand). Same
        // real "resolve scope, then a focused generation call, then one
        // ApprovalRequest per resolved product sharing a groupId" shape as
        // request_image_change above — update_product (genesisActions.ts)
        // is the real, already-existing executable this proposes into,
        // same Approve action Products already has.
        if (chosenTool?.name === "request_product_content_change") {
          diagLog(requestId, turnStartedAt, "tool_selected", { tool: "request_product_content_change" });
          emit({ type: "status", text: "Preparing suggestions…" });
          const input = chosenTool.input as RequestProductContentChangeInput;
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
                ? `I want to make sure I work on the right one — which product did you mean? Your active products are: ${currentProducts.map((p) => p.name).join(", ")}.`
                : conversationalReply || "Which product would you like me to work on?";
            await prisma.storeMessage.create({ data: { storeId: store.id, role: "user", content: userMessage, changes: userMessageChanges } });
            await prisma.storeMessage.create({ data: { storeId: store.id, role: "assistant", content: clarification } });
            if (!streamedAnyText) emit({ type: "token", delta: clarification });
            emit({ type: "done", changes: null });
            await logStreamedChatTurn({ userId, storeId: store.id, durationMs: Date.now() - turnStartedAt, outcome: "failure", likelyRephraseOf, kind: "product_content_change_request" });
            controller.close();
            return;
          }

          const suggestions = await generateProductContentChanges({
            storeId: store.id,
            products: targetProducts.map((p) => ({ id: p.id, name: p.name, description: p.description, priceInCents: p.priceInCents })),
            changeType: input.changeType,
            ownerRequest: userMessage,
          });

          const groupId = randomUUID();
          const proposed: { id: string; name: string }[] = [];
          const unchanged: string[] = [];
          for (const product of targetProducts) {
            const suggestion = suggestions.find((s) => s.productId === product.id);
            const changedFields: { name?: string; description?: string | null } = {};
            if (suggestion?.name && suggestion.name.trim() && suggestion.name.trim() !== product.name) {
              changedFields.name = suggestion.name.trim();
            }
            if (
              input.changeType !== "name" &&
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
                storeId: store.id,
                actionType: "update_product",
                status: "PENDING_APPROVAL",
                input: { path: ["productId"], equals: product.id },
              },
            });
            const previousValues: Record<string, unknown> = { productId: product.id };
            if ("name" in changedFields) previousValues.name = product.name;
            if ("description" in changedFields) previousValues.description = product.description;
            await prisma.approvalRequest.create({
              data: {
                storeId: store.id,
                recommendationId: null,
                actionType: "update_product",
                input: { productId: product.id, ...changedFields },
                previousValues,
                summary: suggestion?.reasoning ? `${product.name}: ${suggestion.reasoning}` : `Update "${product.name}"`,
                authorizationTier: GENESIS_ACTIONS.update_product.authorizationTier,
                groupId,
              },
            });
            proposed.push({ id: product.id, name: product.name });
          }

          const replyParts = [conversationalReply || "I've looked at your products."];
          if (proposed.length > 1) {
            replyParts.push(`I've proposed changes for ${proposed.length}: ${proposed.map((p) => p.name).join(", ")} — review each on Products, or approve all together.`);
          } else if (proposed.length === 1) {
            replyParts.push(`You'll find my proposed change for "${proposed[0].name}" waiting for your review on Products.`);
          }
          if (unchanged.length > 0) {
            replyParts.push(`${unchanged.length > 1 ? "These" : "One"} already read${unchanged.length > 1 ? "" : "s"} well as-is, so I left ${unchanged.length > 1 ? "them" : "it"} unchanged: ${unchanged.join(", ")}.`);
          }
          const finalReply = replyParts.join(" ");
          await prisma.storeMessage.create({ data: { storeId: store.id, role: "user", content: userMessage, changes: userMessageChanges } });
          await prisma.storeMessage.create({ data: { storeId: store.id, role: "assistant", content: finalReply } });
          await recordGenesisExecution({
            action: EXECUTION_ACTIONS.GENESIS_STORE_MESSAGE,
            status: proposed.length > 0 ? "PENDING" : "WARNING",
            verified: false,
            message: proposed.length > 0 ? `Proposed content changes for ${proposed.map((p) => p.name).join(", ")}` : "No real content changes to propose",
            retryable: proposed.length === 0,
            userId,
            storeId: store.id,
            metadata: { groupId, productIds: proposed.map((p) => p.id) },
          });
          emit({ type: "token", delta: finalReply.slice((conversationalReply || "").length) });
          emit({ type: "done", changes: null });
          await logStreamedChatTurn({ userId, storeId: store.id, durationMs: Date.now() - turnStartedAt, outcome: proposed.length > 0 ? "success" : "failure", likelyRephraseOf, kind: "product_content_change_request" });
          controller.close();
          return;
        }

        // J4 conversational approval (2026-08-09) — "I approve all
        // together. Make the change please" was routing back into
        // request_product_content_change (a fresh re-analysis, which
        // honestly found nothing new to change) instead of executing what
        // was already proposed. This tool means "execute exactly what you
        // already presented" — never a new analysis. Reuses the same
        // execute/verify/record machinery the manual "Approve All" button
        // already runs (performApprovePendingChanges ->
        // performApproveGenesisActionGroup/performApproveGenesisAction);
        // the reply is deterministic, matching manage_business_asset's own
        // "the real outcome is reported by code, not the model" discipline
        // — an "I applied and verified this" claim must be airtight.
        if (chosenTool?.name === "approve_pending_changes") {
          diagLog(requestId, turnStartedAt, "tool_selected", { tool: "approve_pending_changes" });
          emit({ type: "status", text: "Applying the approved changes…" });
          let finalReply: string;
          try {
            const result = await performApprovePendingChanges(store.id);
            finalReply = describeApprovalExecutionForChat(result);
          } catch (err) {
            // requireStorePermission (inside the perform* functions) throws
            // a plain Error for a real, insufficient-permission case —
            // ANALYTICS_VIEW is stricter than the STORE_MANAGE gate already
            // passed above, so an Employee role can genuinely reach here.
            // Same honest decline wording as the STORE_MANAGE gate earlier
            // in this route, not a generic failure.
            finalReply =
              err instanceof Error && err.message.includes("permission")
                ? "Approving changes is something only the store owner can do — ask them to approve this, or to give you broader access."
                : "Something went wrong applying those changes — they're still pending, so you can retry from the review page.";
          }
          await prisma.storeMessage.create({ data: { storeId: store.id, role: "user", content: userMessage, changes: userMessageChanges } });
          await prisma.storeMessage.create({ data: { storeId: store.id, role: "assistant", content: finalReply } });
          await recordGenesisExecution({
            action: EXECUTION_ACTIONS.GENESIS_STORE_MESSAGE,
            status: "SUCCESS",
            verified: false,
            message: finalReply,
            retryable: false,
            userId,
            storeId: store.id,
            metadata: {},
          });
          emit({ type: "token", delta: finalReply });
          emit({ type: "done", changes: null });
          await logStreamedChatTurn({ userId, storeId: store.id, durationMs: Date.now() - turnStartedAt, outcome: "success", likelyRephraseOf, kind: "approve_pending_changes" });
          controller.close();
          return;
        }

        // Hard J4 capability requirement (2026-08-08) — "save this",
        // "save this as my logo": the file is ALREADY permanently saved
        // (ingestBusinessAsset wrote a real BusinessRecord the instant the
        // upload completed, unconditionally — confirmed by direct audit
        // that businessProfile's own asset query has no limit or expiry).
        // The reply here is deterministic, not model-generated, precisely
        // because "I've saved it" must be an airtight, always-true claim,
        // never a phrasing the model could get subtly wrong. role stays
        // honest: designation (actually assigning this as THE logo, THE
        // brand guide, etc.) isn't built yet, so this says so plainly
        // rather than pretending — never the old false "I can't save
        // this" either, since the file itself is real and already kept.
        if (chosenTool?.name === "manage_business_asset") {
          diagLog(requestId, turnStartedAt, "tool_selected", { tool: "manage_business_asset" });
          const input = chosenTool.input as ManageBusinessAssetInput;
          const mostRecentAsset = await prisma.businessRecord.findFirst({
            where: { storeId: store.id, entityType: "asset" },
            orderBy: { syncedAt: "desc" },
          });

          // Designation is real now (2026-08-17). This used to answer "that's a
          // capability coming soon", which was honest at the time and is no
          // longer true: lib/businessModel/assets.ts designates and supersedes
          // for real. This is the OWNER-BRINGS-THEIR-OWN-LOGO path, and it
          // matters as much as generating one — an owner who already has a
          // logo has already answered the question.
          //
          // The role vocabulary stays open, matching AssetSchema: whatever the
          // owner called it is kept, and only the logo case is normalised onto
          // the canonical brand.logo role that "put my logo on a t-shirt"
          // resolves against.
          const requestedRole = input.role?.trim() ?? null;
          const isLogoRole = Boolean(requestedRole && /logos?|mark/i.test(requestedRole));
          const roleToAssign = requestedRole ? (isLogoRole ? ASSET_ROLES.brandLogo : requestedRole) : null;

          if (mostRecentAsset && roleToAssign) {
            await designateAsset(store.id, mostRecentAsset.id, roleToAssign);
            if (isLogoRole) {
              // Keep Store.logoUrl in step, exactly as approving a generated
              // logo does — the column is still what every render path reads.
              const parsedAsset = AssetSchema.safeParse(mostRecentAsset.data);
              if (parsedAsset.success) {
                await prisma.store.update({
                  where: { id: store.id },
                  data: { logoUrl: parsedAsset.data.storageUrl },
                });
              }
            }
          }

          const reply = !mostRecentAsset
            ? "I don't see anything uploaded yet to save — share a photo or document and I'll take it from there."
            : roleToAssign
              ? isLogoRole
                ? "Done — that's your logo now. I'll use it wherever your brand shows up, and you can ask me to put it on a t-shirt or a hoodie whenever you want."
                : `Done — I've saved that as your ${roleToAssign}. I'll know what you mean when you refer to it.`
              : `That's already saved as part of your business files. Want me to give it a specific role — like your primary logo — or is keeping it on file for now good?`;

          await prisma.storeMessage.create({ data: { storeId: store.id, role: "user", content: userMessage, changes: userMessageChanges } });
          await prisma.storeMessage.create({ data: { storeId: store.id, role: "assistant", content: reply } });
          await recordGenesisExecution({
            action: EXECUTION_ACTIONS.GENESIS_STORE_MESSAGE,
            status: "SUCCESS",
            verified: false,
            message: reply,
            retryable: false,
            userId,
            storeId: store.id,
            metadata: { kind: "manage_business_asset", hadAsset: !!mostRecentAsset, role: input.role },
          });
          if (!streamedAnyText) emit({ type: "token", delta: reply });
          emit({ type: "done", changes: null });
          await logStreamedChatTurn({ userId, storeId: store.id, durationMs: Date.now() - turnStartedAt, outcome: "success", likelyRephraseOf, kind: "manage_business_asset" });
          controller.close();
          return;
        }

        // edit_store_content, or the model didn't call a tool and didn't
        // produce usable text — both fall back to the existing, unchanged,
        // already-working Server Action. Nothing was persisted for this
        // turn yet, so the fallback's own user-message write is the only
        // one that happens — no duplicate.
        //
        // 2026-08-08 — J4 command execution fix: when THIS call already
        // determined edit_store_content, say so in the fallback event
        // itself, so the client can pass it straight through to
        // applyGenesisMessageToStore instead of that function re-running
        // an entirely independent second classification of the same
        // message — see its own preClassifiedTool comment for the real,
        // confirmed risk this closes (a real rename instruction silently
        // downgraded to pure conversation on disagreement between the two
        // calls). Genuinely unresolved turns (no tool, no usable text)
        // still fall back with no hint, exactly as before.
        const isEditStoreContent = chosenTool?.name === "edit_store_content";
        diagLog(requestId, turnStartedAt, "fallback_emitted", { reason: isEditStoreContent ? "edit_store_content" : "unresolved" });
        emit(isEditStoreContent ? { type: "fallback", reason: "edit_store_content" } : { type: "fallback" });
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
