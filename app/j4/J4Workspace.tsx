"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useFormStatus } from "react-dom";
import { upload as blobUpload } from "@vercel/blob/client";
import { deriveAssessmentState, GENESIS_STATE_META, type GenesisState } from "@/lib/dashboard/genesisState";
import { setGenesisComposing, setGenesisWorking } from "@/lib/dashboard/genesisActivity";
import { USAGE_CEILING_MESSAGE } from "@/lib/dashboard/genesisModelMessages";
import { callGenesisAction } from "@/lib/dashboard/submitGenesisAction";
import { ALLOWED_CONTENT_TYPES, MAX_UPLOAD_BYTES } from "@/lib/businessAssets/uploadAssetFile";
import { SubmitButton } from "@/app/dashboard/SubmitButton";

// The J4 Portal, Phase A (2026-08-08) — a real, dedicated full-screen route
// (app/j4/page.tsx), replacing the floating GenesisAssistant panel for the
// live-store case. Deliberately independent of GenesisAssistant.tsx, not
// importing from it: that component is explicitly deprecated for this use
// case (Sean's own words), staying only for the pre-launch draft flow
// (app/dashboard/page.tsx). Small pieces below (upload button, ceiling
// override, status dot) are intentionally duplicated rather than shared,
// so the deprecated surface can eventually be deleted cleanly without
// this one depending on any part of it.
//
// "You're not opening J4, you're entering J4" — there is no open/closed
// state here at all; visiting this route IS the open state. Every prop
// this needs is resolved server-side in page.tsx and passed down once.
//
// Naming (Sean, 2026-08-08): this is the "J4 Portal," never "J4 Chat" or
// "J4 Assistant" — Dashboard is where the owner sees/manages the business;
// the Portal is where the owner enters the business workspace WITH J4.
// Conversation is the Portal's first real capability, not its definition —
// this same component/route is the intended home for future non-chat
// capabilities (task work, planning, captured ideas), not a second surface
// built elsewhere once those exist. Phase A only implements conversation;
// the component/file structure (one full-screen environment, a header
// identity strip, a center region, a docked input) is deliberately generic
// enough that a future capability composes into the center region rather
// than requiring a rewrite.

type Message = {
  id: string;
  role: string;
  content: string;
  changes: unknown;
};

interface J4Signals {
  hasUrgentIssue: boolean;
  hasPendingDecision: boolean;
  hasOpportunity: boolean;
  hasCuriosity: boolean;
}

// Temporary production tracing (2026-08-08) — carried over from the
// GenesisAssistant investigation; the real streaming/lifecycle path is
// unchanged by the route move, so the same correlated tracing applies
// here. Delete once the real failing layer (if any remains) is confirmed
// fixed on this new route.
function reportDiag(requestId: string, tStart: number, event: string, meta?: Record<string, unknown>) {
  const payload = JSON.stringify({ requestId, event, tMs: Date.now() - tStart, meta });
  try {
    if (typeof navigator !== "undefined" && navigator.sendBeacon) {
      const blob = new Blob([payload], { type: "application/json" });
      navigator.sendBeacon("/api/diag-client-log", blob);
      return;
    }
  } catch {
    // fall through to fetch
  }
  try {
    fetch("/api/diag-client-log", { method: "POST", headers: { "Content-Type": "application/json" }, body: payload, keepalive: true }).catch(() => {});
  } catch {
    // best-effort only — never let diagnostics themselves break the real flow
  }
}

function randomAssetKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function J4StatusDot({ hasUrgentIssue, hasPendingDecision, hasOpportunity, hasCuriosity }: J4Signals) {
  const { pending } = useFormStatus();
  const state: GenesisState = deriveAssessmentState({ hasUrgentIssue, hasPendingDecision, hasOpportunity, hasCuriosity });
  if (state === "idle" && !pending) return null;
  const meta = GENESIS_STATE_META[state];
  return (
    <span
      className={`relative inline-flex h-2 w-2 shrink-0 rounded-full ${meta.dotClassName}`}
      aria-hidden="true"
      title={pending ? "J4 is actively working on your last request" : meta.description}
    >
      {pending && <span className="absolute -inset-1 rounded-full ring-2 ring-blue-400/70 animate-pulse" aria-hidden="true" />}
    </span>
  );
}

function J4WorkingPublisher() {
  const { pending } = useFormStatus();
  useEffect(() => {
    setGenesisWorking(pending);
  }, [pending]);
  return null;
}

function UploadAssetButton({
  label,
  icon,
  accept,
  uploadAsset,
  currentPath,
  onFailure,
}: {
  label: string;
  icon: string;
  accept: string;
  uploadAsset: (formData: FormData) => void;
  currentPath: string;
  onFailure: (message: string) => void;
}) {
  const [isPending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0] ?? null;
          event.target.value = "";
          if (!file) return;
          const extension = ALLOWED_CONTENT_TYPES[file.type];
          if (!extension) {
            onFailure("Please upload a PNG, JPEG, WebP, HEIC, or PDF file.");
            return;
          }
          if (file.size > MAX_UPLOAD_BYTES) {
            onFailure("File is too large — please upload something under 8MB.");
            return;
          }
          startTransition(async () => {
            const result = await callGenesisAction(async () => {
              const blob = await blobUpload(`assets/${randomAssetKey()}.${extension}`, file, {
                access: "public",
                handleUploadUrl: "/api/blob/business-asset-upload",
                contentType: file.type,
              });
              const formData = new FormData();
              formData.set("blobUrl", blob.url);
              formData.set("originalFilename", file.name);
              formData.set("contentType", file.type);
              formData.set("currentPath", currentPath);
              return uploadAsset(formData);
            });
            if (!result.ok) onFailure(result.message);
          });
        }}
      />
      <button
        type="button"
        disabled={isPending}
        onClick={() => inputRef.current?.click()}
        className="rounded-full border border-[rgba(139,124,246,0.18)] px-3 py-1.5 text-xs text-[rgba(244,242,251,0.62)] transition hover:bg-white/[.06] disabled:opacity-50"
      >
        {isPending ? "Uploading…" : `${icon} ${label}`}
      </button>
    </>
  );
}

function ConfirmCeilingOverride({
  sendMessage,
  previousUserMessage,
  currentPath,
  onFailure,
}: {
  sendMessage: (formData: FormData) => void;
  previousUserMessage: string;
  currentPath: string;
  onFailure: (message: string) => void;
}) {
  const [isPending, startTransition] = useTransition();
  return (
    <button
      type="button"
      disabled={isPending}
      onClick={() => {
        const formData = new FormData();
        formData.set("message", previousUserMessage);
        formData.set("confirmedOverride", "true");
        formData.set("currentPath", currentPath);
        startTransition(async () => {
          const result = await callGenesisAction(() => Promise.resolve(sendMessage(formData)));
          if (!result.ok) onFailure(result.message);
        });
      }}
      className="self-start rounded-full border border-[#8b7cf6] px-4 py-1.5 text-sm text-[#8b7cf6] transition-opacity hover:opacity-80 disabled:opacity-50"
    >
      {isPending ? "Continuing…" : "Continue anyway"}
    </button>
  );
}

export function J4Workspace({
  storeName,
  messages,
  sendMessage,
  uploadAsset,
  hasUrgentIssue,
  hasPendingDecision,
  hasOpportunity,
  hasCuriosity,
}: {
  storeName: string;
  messages: Message[];
  sendMessage: (formData: FormData) => void;
  uploadAsset: (formData: FormData) => void;
} & J4Signals) {
  const currentPath = "/j4";

  // Server-persisted StoreMessage rows stay the one source of truth;
  // localMessages is a working cache that appends the optimistic turn and
  // grows the streamed reply, resynced from real server data whenever it
  // changes (React's own recommended "adjust state during render" pattern
  // — see the same reasoning this replaced in GenesisAssistant.tsx).
  const [localMessages, setLocalMessages] = useState<Message[]>(messages);
  const [syncedMessages, setSyncedMessages] = useState(messages);
  if (messages !== syncedMessages) {
    setSyncedMessages(messages);
    setLocalMessages(messages);
  }
  const [streamingStatus, setStreamingStatus] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  // Directly tests "is the component/page lifecycle killing the request" —
  // set for the duration of a real turn so a real disconnect/backgrounding
  // event can be reported precisely, not just generically.
  const inFlightRequestRef = useRef<{ requestId: string; tStart: number } | null>(null);
  useEffect(() => {
    function onVisibilityChange() {
      const inFlight = inFlightRequestRef.current;
      if (!inFlight) return;
      reportDiag(inFlight.requestId, inFlight.tStart, "page_visibility_changed", { visibilityState: document.visibilityState });
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);
  useEffect(() => {
    return () => {
      const inFlight = inFlightRequestRef.current;
      if (!inFlight) return;
      reportDiag(inFlight.requestId, inFlight.tStart, "component_unmounted_while_request_in_flight");
    };
  }, []);

  async function sendViaServerAction(formData: FormData) {
    const result = await callGenesisAction(() => Promise.resolve(sendMessage(formData)));
    if (!result.ok) setSendError(result.message);
  }

  // The reconciliation check. Per the already-shipped server-side fix
  // (app/api/chat/route.ts's emit()), a dead connection no longer aborts
  // generation or persistence — the real turn keeps going and its result
  // gets written regardless of whether this client is still listening. A
  // mid-stream disconnect must never immediately tell the owner to
  // resend: check whether the real reply already landed first. Two short,
  // bounded attempts, not a polling/reconnection system.
  async function tryRecoverPersistedReply(assistantId: string, turnStartedAtMs: number): Promise<boolean> {
    for (const delayMs of [0, 1800]) {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      try {
        const res = await fetch("/api/chat/recent-messages", { cache: "no-store" });
        if (!res.ok) continue;
        const data = (await res.json()) as {
          messages: { id: string; role: string; content: string; changes: unknown; createdAt: string }[];
        };
        const realReply = data.messages.find((m) => m.role === "assistant" && new Date(m.createdAt).getTime() >= turnStartedAtMs);
        if (realReply) {
          setLocalMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { id: realReply.id, role: realReply.role, content: realReply.content, changes: realReply.changes } : m))
          );
          return true;
        }
      } catch {
        continue;
      }
    }
    return false;
  }

  async function handleSend(formData: FormData) {
    setSendError(null);
    setStreamingStatus(null);
    const text = String(formData.get("message") ?? "").trim();
    if (!text) return;

    const optimisticUserId = `optimistic-user-${Date.now()}`;
    const assistantId = `optimistic-assistant-${Date.now()}`;
    setLocalMessages((prev) => [
      ...prev,
      { id: optimisticUserId, role: "user", content: text, changes: null },
      { id: assistantId, role: "assistant", content: "", changes: null },
    ]);
    const rollBackOptimisticEntries = () =>
      setLocalMessages((prev) => prev.filter((m) => m.id !== optimisticUserId && m.id !== assistantId));

    const requestId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const tStart = Date.now();
    inFlightRequestRef.current = { requestId, tStart };
    reportDiag(requestId, tStart, "client_fetch_start");

    let response: Response;
    try {
      response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, requestId }),
      });
    } catch (err) {
      reportDiag(requestId, tStart, "client_fetch_threw", { message: err instanceof Error ? err.message : String(err) });
      inFlightRequestRef.current = null;
      rollBackOptimisticEntries();
      await sendViaServerAction(formData);
      return;
    }
    reportDiag(requestId, tStart, "client_fetch_resolved", { ok: response.ok, status: response.status, hasBody: !!response.body });

    if (!response.ok || !response.body) {
      inFlightRequestRef.current = null;
      rollBackOptimisticEntries();
      await sendViaServerAction(formData);
      return;
    }

    try {
      const reader = response.body.getReader();
      reportDiag(requestId, tStart, "client_reader_created");
      const decoder = new TextDecoder();
      let buffer = "";
      let sawDone = false;
      let sawFallback = false;
      let sawFirstChunk = false;
      let sawFirstToken = false;

      readLoop: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!sawFirstChunk) {
          sawFirstChunk = true;
          reportDiag(requestId, tStart, "client_first_chunk_received", { byteLength: value?.length ?? 0 });
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as
            | { type: "padding" }
            | { type: "status"; text: string }
            | { type: "token"; delta: string }
            | { type: "done" }
            | { type: "fallback" }
            | { type: "error"; message: string };

          if (event.type === "padding") {
            reportDiag(requestId, tStart, "client_padding_event_received");
            continue;
          } else if (event.type === "status") {
            reportDiag(requestId, tStart, "client_status_event_received", { text: event.text });
            setStreamingStatus(event.text);
          } else if (event.type === "token") {
            if (!sawFirstToken) {
              sawFirstToken = true;
              reportDiag(requestId, tStart, "client_first_token_setstate", { deltaLength: event.delta.length });
            }
            setStreamingStatus(null);
            setLocalMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: m.content + event.delta } : m)));
          } else if (event.type === "done") {
            sawDone = true;
            reportDiag(requestId, tStart, "client_done_event_received");
            setStreamingStatus(null);
          } else if (event.type === "fallback") {
            sawFallback = true;
            reportDiag(requestId, tStart, "client_fallback_event_received");
            break readLoop;
          } else if (event.type === "error") {
            reportDiag(requestId, tStart, "client_error_event_received", { message: event.message });
            setStreamingStatus(null);
            setSendError(event.message);
            rollBackOptimisticEntries();
            return;
          }
        }
      }

      if (sawFallback) {
        rollBackOptimisticEntries();
        await sendViaServerAction(formData);
        return;
      }

      if (!sawDone) {
        reportDiag(requestId, tStart, "client_stream_ended_no_terminal_event");
        setStreamingStatus("Checking whether that finished…");
        const recovered = await tryRecoverPersistedReply(assistantId, tStart);
        setStreamingStatus(null);
        if (!recovered) {
          setSendError("Lost the live connection before seeing J4 finish — it may still complete on its own. Reload in a moment to check.");
          rollBackOptimisticEntries();
        }
      }
    } catch (err) {
      reportDiag(requestId, tStart, "client_read_loop_threw", {
        message: err instanceof Error ? err.message : String(err),
        name: err instanceof Error ? err.name : undefined,
      });
      setStreamingStatus("Checking whether that finished…");
      const recovered = await tryRecoverPersistedReply(assistantId, tStart);
      setStreamingStatus(null);
      if (!recovered) {
        setSendError("Connection interrupted — J4 may have kept working. Reload to check before sending that again.");
        rollBackOptimisticEntries();
      }
    } finally {
      inFlightRequestRef.current = null;
      setStreamingStatus(null);
    }
  }

  const lastMessage = localMessages[localMessages.length - 1];
  const showConfirmCeiling = lastMessage?.role === "assistant" && lastMessage.content === USAGE_CEILING_MESSAGE;
  const previousUserMessage = showConfirmCeiling ? [...localMessages].reverse().find((m) => m.role === "user")?.content : undefined;

  const messageListRef = useRef<HTMLDivElement>(null);
  const lastMessageContentLength = lastMessage?.content.length ?? 0;
  useEffect(() => {
    const el = messageListRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [localMessages.length, lastMessageContentLength]);

  return (
    <form action={handleSend} className="fixed inset-0 z-[100] flex flex-col bg-[#07060d] text-[#f4f2fb]">
      <input type="hidden" name="currentPath" value={currentPath} />

      <div className="flex shrink-0 items-start justify-between border-b border-[rgba(139,124,246,0.18)] px-5 py-4 pt-[calc(1rem+env(safe-area-inset-top))]">
        <div>
          <div className="flex items-center gap-2">
            <p className="font-[var(--font-heading,inherit)] text-lg font-semibold text-[#f4f2fb]">How can J4 help today?</p>
            <J4StatusDot
              hasUrgentIssue={hasUrgentIssue}
              hasPendingDecision={hasPendingDecision}
              hasOpportunity={hasOpportunity}
              hasCuriosity={hasCuriosity}
            />
            <J4WorkingPublisher />
          </div>
          <p className="mt-1 text-xs text-[rgba(244,242,251,0.62)]">Your business partner for {storeName}</p>
        </div>
        <Link
          href="/dashboard"
          aria-label="Return to dashboard"
          className="-m-2 shrink-0 p-2 text-[rgba(244,242,251,0.62)] hover:text-[#f4f2fb]"
        >
          ✕
        </Link>
      </div>

      <div
        ref={messageListRef}
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain p-5"
      >
        {localMessages.length === 0 ? (
          <div className="text-sm text-[rgba(244,242,251,0.62)]">
            <p className="font-medium text-[#f4f2fb]">Your business partner, always paying attention.</p>
            <p className="mt-1">
              Ask J4 to change something, or just check in — it&apos;s already
              watching for what needs you, and will tell you what it&apos;s
              noticed or handled.
            </p>
          </div>
        ) : (
          localMessages.map((m, i) => {
            const changes = m.changes as string[] | null;
            const isStreamingPlaceholder = i === localMessages.length - 1 && m.role === "assistant" && m.content === "";
            return (
              <div
                key={m.id}
                className={
                  m.role === "user"
                    ? "self-end rounded-lg bg-[#8b7cf6] px-3 py-2 text-sm text-white"
                    : "self-start rounded-lg border border-[rgba(139,124,246,0.18)] bg-[#8b7cf6]/10 px-3 py-2 text-sm text-[#f4f2fb]"
                }
              >
                {isStreamingPlaceholder ? (
                  <p className="flex items-center gap-1.5 italic opacity-70">
                    <span className="inline-flex h-1.5 w-1.5 animate-pulse rounded-full bg-current" aria-hidden="true" />
                    {streamingStatus ?? "Thinking…"}
                  </p>
                ) : (
                  <p>{m.content}</p>
                )}
                {changes && changes.length > 0 && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs opacity-60 hover:opacity-100">See what changed</summary>
                    <ul className="mt-1 list-disc pl-4 text-xs opacity-75">
                      {changes.map((c, i) => (
                        <li key={i}>{c}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            );
          })
        )}
      </div>

      {showConfirmCeiling && previousUserMessage && (
        <div className="shrink-0 border-t border-[rgba(139,124,246,0.18)] px-5 pt-3">
          <ConfirmCeilingOverride
            sendMessage={sendMessage}
            previousUserMessage={previousUserMessage}
            currentPath={currentPath}
            onFailure={setSendError}
          />
        </div>
      )}

      {sendError && (
        <div className="shrink-0 border-t border-[rgba(139,124,246,0.18)] px-5 pt-3 text-sm text-red-400">{sendError}</div>
      )}

      <div className="flex shrink-0 flex-col gap-2 border-t border-[rgba(139,124,246,0.18)] p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))]">
        <div className="flex flex-wrap items-center gap-2">
          <UploadAssetButton
            label="Upload Photos"
            icon="📷"
            accept="image/png,image/jpeg,image/webp,image/heic,image/heif"
            uploadAsset={uploadAsset}
            currentPath={currentPath}
            onFailure={setSendError}
          />
          <UploadAssetButton
            label="Upload Documents"
            icon="📄"
            accept="application/pdf"
            uploadAsset={uploadAsset}
            currentPath={currentPath}
            onFailure={setSendError}
          />
          <span className="cursor-default rounded-full border border-dashed border-[rgba(244,242,251,0.2)] px-3 py-1.5 text-xs text-[rgba(244,242,251,0.4)]">
            🎬 Upload Videos — coming soon
          </span>
        </div>
        <textarea
          name="message"
          placeholder="Ask J4 anything about your business…"
          rows={2}
          required
          onFocus={() => setGenesisComposing(true)}
          onBlur={() => setGenesisComposing(false)}
          className="rounded-lg border border-[rgba(139,124,246,0.18)] bg-[#100d1c] px-3 py-2 text-sm text-[#f4f2fb] placeholder:text-[rgba(244,242,251,0.62)]"
        />
        <SubmitButton
          pendingText="J4 is thinking…"
          laterPendingText="Still working on it — detailed answers can take a little longer…"
          showPendingDot
          className="self-start rounded-full bg-[var(--brand-accent,#8b7cf6)] px-4 py-1.5 text-sm font-medium text-white shadow-sm transition-opacity hover:opacity-90 disabled:opacity-90"
        >
          Ask J4
        </SubmitButton>
      </div>
    </form>
  );
}
