import { withJ4CopyRules } from "@/lib/j4CopyRules";
import { auth } from "@/auth";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { PERMISSIONS, hasPermission } from "@/lib/permissions";
import { mayInvokeTool, refusalMessage, planToolRun, describeDroppedTools } from "@/lib/execution/toolPolicy";
import { routeToolHandlers, type ToolTurnResult } from "@/lib/execution/toolHandlers";
import { businessFromSlug, resolveBusiness } from "@/lib/businessContext";
import { callGenesisModel, genesisModelFailureMessage } from "@/lib/genesisModel";
import { EXECUTION_ACTIONS } from "@/lib/execution/actions";
import { recordGenesisExecution } from "@/lib/execution/genesis";
import { logProductEvent, findLikelyRephraseOf } from "@/lib/telemetry/events";
import { buildChatDataContext } from "@/lib/businessModel/reasoning";
import { groundingRules, unsourcedCount } from "@/lib/businessModel/grounding";
import { buildTurnContext } from "@/lib/dashboard/chatTurnContext";
import { findRelevantMessages } from "@/lib/businessModel/conversationRecall";
import { findRelevantDecisions } from "@/lib/businessModel/reasoning";
import { growthPointCostsFor } from "@/lib/growthPoints/catalog";
import { PROPOSABLE_ACTION_TYPES } from "@/lib/intelligence/cognitiveLayer";
import { businessBasePath, sectionHref } from "@/lib/dashboard/navConfig";
import {
  allToolUses,
  buildStoreChatUnifiedTools,
  textOf,
} from "@/lib/execution/genesisTools";
import {
  STORE_CHAT_DATA_ANSWER_SYSTEM_PROMPT,
  STORE_CHAT_UNIFIED_SYSTEM_PROMPT,
} from "@/lib/dashboard/storeChatUnified";

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
  // J4 taking the owner somewhere (2026-08-18). Emitted just before "done" so
  // the reply is on screen before the move; the client pushes the route.
  // Closed set of hrefs on the server side, so nothing the model invents can
  // reach the router.
  | { type: "navigate"; href: string }
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
    | { message?: string; requestId?: string; audioUrl?: string; workspacePath?: string; slug?: string }
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

  // THE BUSINESS THIS TURN IS ABOUT, TAKEN FROM THE REQUEST (2026-08-21,
  // BUSINESS_CONTEXT.md Phase C).
  //
  // J4Surface was fixed in August to render the business named in the URL — but
  // SENDING a message still posted here, where the account's ACTIVE business was
  // resolved instead. So on /b/copper-coil the conversation on screen was Copper
  // & Coil's and the reply was written against Iron Gym: the same defect the
  // browser test found for the surface, still live on the path that writes.
  //
  // The slug is authoritative when the client sends one. The legacy /dashboard
  // route has no slug and still resolves the active business, exactly as before.
  const requestedSlug = typeof body?.slug === "string" ? body.slug.trim() : "";
  // businessFromSlug owns the refusal rule: a slug naming nothing, or naming a
  // business this account cannot reach, is null and null is not a fallback.
  const named = requestedSlug ? await businessFromSlug(userId, requestedSlug) : null;
  if (requestedSlug && !named) {
    return new Response(JSON.stringify({ type: "error", message: "No permission." }), { status: 403 });
  }

  const resolution = await resolveBusiness(userId, named?.store.id);
  // More than one business and nothing saying which is a question, not a guess.
  // Said as its own status so the client can send the person to choose rather
  // than showing them a permission error they cannot act on.
  if (resolution.kind === "ambiguous") {
    diagLog(requestId, turnStartedAt, "business_ambiguous");
    return new Response(
      JSON.stringify({ type: "error", message: "Choose which business this is for first." }),
      { status: 409 }
    );
  }
  if (resolution.kind === "none" || !hasPermission(resolution.role, PERMISSIONS.GENESIS_CHAT)) {
    diagLog(requestId, turnStartedAt, "permission_failed");
    return new Response(JSON.stringify({ type: "error", message: "No permission." }), { status: 403 });
  }
  const { store, role } = resolution;
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

        // THE UPLOAD-INTENT PRE-CALL USED TO SIT HERE (removed 2026-08-22).
        //
        // A full model round trip, on EVERY message, to answer one question
        // before the unified call ran at all. It was here for a permission
        // reason rather than a reasoning one — it had to answer before the
        // blanket store:manage gate — and that gate has since moved onto the
        // individual tool, so the ordering constraint is gone.
        //
        // It is now show_upload_options, an ordinary tool handled below. Not a
        // pattern match: the old prompt had to tell "I have a PDF for you" from
        // "the photo on my homepage looks bad" from "remove the old products
        // and let's upload the first ring", where uploading is real but is not
        // the whole message and answering it as though it were would silently
        // drop a real removal instruction. That is language understanding, and
        // a regex doing it badly would make J4 worse rather than cheaper.

        // THE BLANKET store:manage GATE USED TO SIT HERE (moved 2026-08-22,
        // Unified Intelligence UI2).
        //
        // It refused the whole conversation rather than the capability, so a
        // member with genesis:chat and without store:manage was declined for
        // EVERYTHING — including "what was my revenue last week", which
        // look_up_business_data is read-only and would have answered — with copy
        // telling them their question was a change attempt.
        //
        // Authorization now happens where the decision actually is: against the
        // tool the model chose, via lib/execution/toolPolicy.ts, immediately
        // after selection and before any handler runs. Nothing is loosened
        // except two genuinely read-only tools; every mutating tool still
        // requires exactly store:manage.
        //
        // Reaching the model is not itself a grant. The unified context carries
        // no owner-scoped material — getBusinessUnderstanding withholds that
        // from anyone who is not the owner, by viewer id — and no tool handler
        // runs before the check below.


        const currentProducts = await prisma.product.findMany({
          where: { storeId: store.id, active: true },
          select: { id: true, name: true, description: true, priceInCents: true, imageUrl: true, richContent: true },
          orderBy: { position: "asc" },
        });
        const pending = store.pendingChange as { summary: string } | null;
        const activeProductNames = currentProducts.map((p) => p.name).join(", ") || "none";
        // WHAT J4 IS TOLD, ASSEMBLED ONCE (2026-08-22, Unified Intelligence UI4).
        //
        // This list used to be built here line by line, and identically-but-not-
        // quite in app/dashboard/ai-actions.ts. By the time it was extracted the
        // two had already diverged — this path told J4 about a proposal on the
        // table and the other did not, so the same push-back refined an existing
        // idea here and started a fresh one there.
        //
        // The builder also fetches the canonical understanding, ONCE, and hands
        // it back: the data branch below reuses this object rather than reading
        // it again.
        const turn = await buildTurnContext({
          storeId: store.id,
          // The authenticated viewer, never the store owner — see the builder.
          userId,
          userMessage,
          activeProductNames,
          workspacePath: body?.workspacePath,
          pendingSummary: pending?.summary ?? null,
        });
        const { understanding } = turn;
        const unifiedContextParts = turn.parts;

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

        // EVERY TOOL THE MODEL ASKED FOR, then what policy allows to run
        // (2026-08-22, Unified Intelligence UI3).
        //
        // firstToolUse took the first block and discarded the rest — silently.
        // A turn where the merchant asked for two things did one of them and
        // said nothing about the other, which leaves them believing both
        // happened. That is the same failure as reporting a change that did not
        // occur, arriving from the other direction.
        //
        // planToolRun applies two rules: a cap, and AT MOST ONE MUTATION per
        // turn. Reading twice is J4 doing its job; changing two things in one
        // unreviewed turn is a turn nobody watched. So on a two-action message
        // the second action is still not executed — deliberately — but it is no
        // longer invisible.
        const requestedTools = allToolUses(unifiedOutcome.message.content);
        const plan = planToolRun(requestedTools.map((t) => t.name));
        const plannedTools = plan.run
          .map((name) => requestedTools.find((t) => t.name === name))
          .filter((t): t is NonNullable<typeof t> => t !== undefined);
        const chosenTool = plannedTools[0] ?? null;
        const conversationalReply = textOf(unifiedOutcome.message.content);
        if (plan.dropped.length > 0) {
          diagLog(requestId, turnStartedAt, "tools_dropped", { dropped: plan.dropped });
        }

        // AUTHORIZATION, AT THE DECISION (2026-08-22, UI2). Before any handler
        // below runs, and shared with the Server Action path so one permission
        // question has exactly one answer.
        if (chosenTool) {
          const permission = mayInvokeTool(role, chosenTool.name);
          if (!permission.allowed) {
            const declineMessage = refusalMessage(permission);
            diagLog(requestId, turnStartedAt, "tool_refused", {
              tool: chosenTool.name,
              reason: permission.reason,
            });
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
              metadata: { refusedTool: chosenTool.name, reason: permission.reason },
            });
            // Whatever the model streamed before choosing the tool is already on
            // the wire; the refusal follows it rather than replacing it, because
            // pretending nothing was said would leave a half-sentence hanging.
            emit({ type: "token", delta: streamedAnyText ? `\n\n${declineMessage}` : declineMessage });
            emit({ type: "done", changes: null });
            await logStreamedChatTurn({ userId, storeId: store.id, durationMs: Date.now() - turnStartedAt, outcome: "success", likelyRephraseOf, kind: "tool_refused" });
            controller.close();
            return;
          }
        }

        // Pure conversation — already fully streamed above. Persist and
        // finish; no further model or tool work needed.
        // WHAT WAS ASKED FOR AND IS NOT HAPPENING, said out loud (2026-08-22).
        //
        // Written as its own assistant message BEFORE the work, so it is both
        // streamed and persisted — a notice appended only to the stream would
        // leave the stored conversation disagreeing with what the owner read.
        // Phrased forward-looking because that is what is true: the thing was
        // understood, it simply is not part of this turn.
        if (plan.dropped.length > 0 && chosenTool) {
          const notice = describeDroppedTools(plan.dropped);
          await prisma.storeMessage.create({ data: { storeId: store.id, role: "assistant", content: notice } });
          emit({ type: "token", delta: streamedAnyText ? `\n\n${notice}` : notice });
          streamedAnyText = true;
        }

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

        // MIGRATED TOOLS RUN HERE, AND MORE THAN ONE OF THEM CAN
        // (2026-08-22, Unified Intelligence UI3).
        //
        // A handler returns what it did instead of writing messages, emitting
        // and closing the stream itself — so the turn owns all of that once,
        // however many handlers ran, and two tools in a turn is finally
        // expressible rather than structurally impossible.
        //
        // Only the tools that have moved to lib/execution/toolHandlers.ts. The
        // rest still run inline below, exactly as before: moving nineteen
        // bespoke branches in one pass, with no coverage to catch a mistake, is
        // how a working product breaks quietly.
        // Typed from the handler contract itself rather than restated here — a
        // hand-written copy is how a new field silently stops reaching the turn.
        const handlerResults: Extract<ToolTurnResult, { handled: true }>[] = [];
        let unhandledByHandlers: typeof plannedTools[number] | null = null;
        let invalidToolInput = false;

        // Bound to this business, so navigation addresses the store the owner is
        // actually in rather than whichever one their account last made active.
        const boundHandlers = routeToolHandlers({
          resolveHref: (href) => sectionHref(href, businessBasePath(store.slug)),
        });

        for (const tool of plannedTools) {
          const handler = Object.hasOwn(boundHandlers, tool.name) ? boundHandlers[tool.name] : null;
          if (!handler) {
            // Falls through to the inline ladder. Only ONE can, because those
            // branches still end the turn themselves.
            unhandledByHandlers = tool;
            break;
          }
          const outcome = await handler({
            storeId: store.id,
            userId,
            userMessage,
            conversationalReply,
            input: tool.input,
            status: (text) => emit({ type: "status", text }),
            // The turn already fetched these to tell the model what exists;
            // a handler reading them again would be a second answer to the
            // same question one query later.
            // Wider than {id, name}: sourcing a replacement photo needs what
            // the product actually IS, and its current image so the replacement
            // is not the thing being replaced.
            products: currentProducts.map((p) => ({
              id: p.id,
              name: p.name,
              description: p.description,
              imageUrl: p.imageUrl,
              priceInCents: p.priceInCents,
              richContent: p.richContent,
            })),
          });
          if (!outcome.handled) {
            // The model's input did not make sense. Nothing was written, so the
            // honest move is the ordinary fallback rather than confirming
            // something that never happened.
            invalidToolInput = true;
            break;
          }
          diagLog(requestId, turnStartedAt, "tool_selected", { tool: tool.name });
          handlerResults.push(outcome);
        }

        if (invalidToolInput) {
          emit({ type: "fallback" });
          controller.close();
          return;
        }

        // Every planned tool was handled here: end the turn once, with one
        // user message and one assistant message per thing that was done.
        if (handlerResults.length > 0 && !unhandledByHandlers) {
          await prisma.storeMessage.create({ data: { storeId: store.id, role: "user", content: userMessage, changes: userMessageChanges } });
          for (const result of handlerResults) {
            await prisma.storeMessage.create({
              data: {
                storeId: store.id,
                role: "assistant",
                content: result.reply,
                // How a rendered artefact — a composition, a mockup — reaches
                // the panel that draws it.
                ...(result.messageChanges ? { changes: result.messageChanges } : {}),
              },
            });
            await recordGenesisExecution({
              action: EXECUTION_ACTIONS.GENESIS_STORE_MESSAGE,
              // PENDING is the honest status for a PROPOSAL: real work happened
              // and nothing changed yet. Defaulting to SUCCESS would record a
              // proposed deletion as a completed one.
              status: result.executionStatus ?? "SUCCESS",
              verified: false,
              retryable: result.retryable ?? false,
              userId,
              storeId: store.id,
              message: result.logMessage ?? result.reply,
              metadata: { kind: result.kind, ...(result.metadata ?? {}) },
            });
            // The model may already have streamed its own words; a handler's
            // reply follows rather than replacing them.
            if (!streamedAnyText) {
              emit({ type: "token", delta: result.reply });
              streamedAnyText = true;
            } else if (result.reply !== conversationalReply) {
              emit({ type: "token", delta: `\n\n${result.reply}` });
            }
            // Moving the owner is the turn's job, not the handler's — a handler
            // that touched the stream could never be the first of two.
            if (result.navigate) emit({ type: "navigate", href: result.navigate });
            // A cached render the handler's work just invalidated. Done here
            // because revalidatePath only makes sense inside a request — a
            // handler that called it could not be tested outside one.
            for (const path of result.revalidate
              ? Array.isArray(result.revalidate)
                ? result.revalidate
                : [result.revalidate]
              : []) {
              revalidatePath(path);
            }
          }
          emit({ type: "done", changes: null });
          await logStreamedChatTurn({
            userId,
            storeId: store.id,
            durationMs: Date.now() - turnStartedAt,
            // A handler that could not give the owner what they asked for is
            // not a success, and recording it as one hides the turns worth
            // looking at.
            outcome: handlerResults.some((r) => r.outcome === "failure") ? "failure" : "success",
            likelyRephraseOf,
            kind: handlerResults.map((r) => r.kind).join("+"),
          });
          controller.close();
          return;
        }

        // One tool with no handler yet: the inline ladder below handles it,
        // unchanged. chosenTool already points at the first planned tool.

        if (chosenTool?.name === "look_up_business_data") {
          diagLog(requestId, turnStartedAt, "tool_selected", { tool: "look_up_business_data" });
          emit({ type: "status", text: "Reviewing your storefront…" });
          diagLog(requestId, turnStartedAt, "status_reviewing_emitted");
          // GAP D RESOLVED (2026-08-18). The owner's own question drives an
          // unbounded search of decisions they actually made, so "did we ever
          // decide about renaming the shop" reaches a decision from any age
          // rather than only the 14-day window `recentDecisions` carries.
          //
          // Both are supplied because they answer different questions:
          // recentDecisions is "what has been settled lately", pastDecisions is
          // "what bears on what you just asked". An empty pastDecisions is a
          // real answer — nothing on record matches — and is better than
          // handing the model the newest decision and letting it improvise a
          // connection.
          // `understanding` is already in hand from before the decision — the
          // same object, not a second read. Re-fetching here would have made the
          // digest a genuine extra query rather than a relocated one.
          const [dataContext, pastDecisions, pastStatements] = await Promise.all([
            buildChatDataContext(store.id),
            findRelevantDecisions(store.id, userMessage),
            // M9 — the owner's own past words, any age. Gap D's twin: the same
            // relevance-over-recency rule, applied to the conversation those
            // decisions came out of.
            findRelevantMessages(store.id, userMessage),
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
                      // HOW TO READ THE `source` ALREADY ON THOSE FACTS
                      // (2026-08-22, U6). The profile's records carry their own
                      // provenance, and carrying it without explaining it is
                      // just more JSON — these are the rules for the kinds
                      // actually present, and the honest count of what has none.
                      sourceGuidance: groundingRules([
                        ...understanding.profile.goals,
                        ...understanding.profile.challenges,
                        ...understanding.profile.assets,
                      ]),
                      factsWithNoRecordedSource: unsourcedCount([
                        ...understanding.profile.goals,
                        ...understanding.profile.challenges,
                        ...understanding.profile.assets,
                      ]),
                      beliefs: understanding.beliefs,
                      recentDecisions: understanding.recentDecisions,
                      // Searchable, any age, ranked by relevance to the
                      // question. ageDays is included so J4 can say "you ruled
                      // that out about seven months ago" rather than reciting a
                      // date the owner has to do arithmetic on.
                      pastDecisionsRelevantToThisQuestion: pastDecisions,
                      pastStatementsByTheOwnerRelevantToThisQuestion: pastStatements,
                      // Dated commitments read out of the owner's own uploaded
                      // documents. Same object as the non-streaming path, for
                      // Gap B's reason: both paths draw on identical
                      // understanding or neither can be trusted.
                      commitments: understanding.commitments,
                      // Patterns about the owner, not the business. Populated only for the
                      // owner themselves; empty for anyone else with access to this store.
                      ownerUnderstanding: understanding.ownerUnderstanding,
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

        // 2026-08-08 — the real missing capability: J4 previously had no
        // way to remove a product at all and told the owner to do it
        // manually. This never executes the deletion itself (delete_product
        // is a hard-locked "destructive" category action — see
        // genesisActions.ts's CATEGORY_MAX_TIER) — it proposes one
        // ApprovalRequest per resolved product, same shape as
        // request_image_change above, and the owner's real confirmation is
        // the existing Approve action on Products, not a second bespoke
        // confirmation UI.
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
        // Storefront compositions (2026-08-18) — collage, hero, featured
        // section. The same Design model as apparel, pointed at a storefront
        // surface. Not a product: see approve_composition below.
        // J4 forms an opinion about the storefront and shows the fix
        // (2026-08-18). P2/P3.
        //
        // The loop Sean asked for: evaluate -> explain -> generate the proposed
        // composition -> preview -> approve. Approval is the existing
        // approve_composition path, so the storefront asset it produces is the
        // same object collages already produce. No parallel system.
        //
        // The evaluation is FACTS; the judgement is J4's, in the reply. That
        // split is deliberate — "J4 doesn't surface everything he can detect,
        // he decides what is worth bringing to the owner."
        // Approving a composition makes it a STOREFRONT ASSET, never a product.
        // Sean: J4 has to understand the difference between something a
        // customer can buy and something that makes the store look better.
        // J4 takes the owner there rather than telling them where it is
        // (2026-08-18).
        //
        // Deliberately LAST among the doing-tools in this file's ordering
        // sense: every capability that can perform the work has its own
        // handler, and this one only runs when the right answer is a place.
        // The tool description carries the rule that keeps it from swallowing
        // ordinary questions — a question gets an answer, a decision gets a
        // destination.
        //
        // The destination map is closed, so a hallucinated route cannot reach
        // the router. `intent` rides along as a handoff, which is the same
        // mechanism a Studio recommendation already uses: the screen arrives
        // with the request ready instead of blank.
        // J4 approvable product content changes (2026-08-09) — "if J4 can
        // perform the change, J4 should perform the change after I
        // approve it... product names, descriptions" (Sean, real feedback
        // after J4 told him to paste suggested names in by hand). Same
        // real "resolve scope, then a focused generation call, then one
        // ApprovalRequest per resolved product sharing a groupId" shape as
        // request_image_change above — update_product (genesisActions.ts)
        // is the real, already-existing executable this proposes into,
        // same Approve action Products already has.
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
