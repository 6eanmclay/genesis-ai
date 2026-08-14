"use client";

// J4 Room, Phase 1 (2026-08-08) — "It should feel like the user has
// stepped away from the dashboard and is now sitting down with their
// business partner" (Sean). A new, separate, immersive screen — entered
// via the doorway button in J4Workspace.tsx's own composer, exited back
// to /j4. Deliberately reuses the exact same StoreMessage data and server
// actions the Workspace uses (sendMessage, uploadVoiceMemo, /api/chat) —
// one real conversation, two presentations, never a second chat system.
//
// This file's own send/streaming orchestration (handleSend below) is a
// genuine, independent reimplementation of J4Workspace.tsx's handleSend,
// not a shared hook — Sean's explicit call, 2026-08-08: "keep the
// existing /j4 Workspace implementation untouched... the priority is
// getting Room built without destabilizing the existing workspace." It
// keeps the same real correctness properties (optimistic message,
// flushSync+nextPaint for genuine token-by-token painting, fallback to
// the non-streaming Server Action, reconciliation-on-disconnect) — it
// deliberately drops J4Workspace's own reportDiag() production-tracing
// calls, which were built to debug one specific, now-fixed historical
// streaming bug on that route and aren't load-bearing behavior.
import { useRef, useState } from "react";
import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import { flushSync } from "react-dom";
import { GENESIS_ATMOSPHERE } from "@/lib/dashboard/genesisAtmosphere";
import { setGenesisComposing } from "@/lib/dashboard/genesisActivity";
import { callGenesisAction } from "@/lib/dashboard/submitGenesisAction";
import { SubmitButton } from "@/app/dashboard/SubmitButton";
import { GenesisAvatar } from "@/app/dashboard/GenesisAvatar";
import { GENESIS_AVATAR_SIZE } from "@/lib/dashboard/genesisAvatarSize";
import { extractAudioUrl, extractImageUrl } from "../messageChanges";
import { VoiceMemoButton } from "../VoiceMemoButton";
import { J4SpeakButton } from "../J4SpeakButton";

type Message = { id: string; role: string; content: string; changes: unknown };

// Same standard-paint-yield technique as J4Workspace.tsx's own nextPaint —
// see that file's comment for the real, confirmed reason this matters
// (flushSync alone doesn't force the browser to actually paint a frame).
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== "undefined") {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}

// Same four-bar "J4 is responding" visual language as J4Workspace's own
// J4ResponseIndicator (same .j4-response-bars global CSS animation,
// app/globals.css) — a simpler local version without that component's
// production-tracing DOM instrumentation, which was built for one
// specific, already-fixed historical bug and isn't needed on a new route.
function RoomResponseIndicator({ streamingStatus }: { streamingStatus: string | null }) {
  return (
    <div className="mt-1 flex min-w-0 items-center gap-2">
      <div className="j4-response-bars flex items-end gap-1" role="status" aria-label="J4 is responding">
        <span className="block w-1 rounded-sm bg-[#8b7cf6]" style={{ height: 6 }} />
        <span className="block w-1 rounded-sm bg-[#8b7cf6]" style={{ height: 10 }} />
        <span className="block w-1 rounded-sm bg-[#8b7cf6]" style={{ height: 16 }} />
        <span className="block w-1 rounded-sm bg-[#8b7cf6]" style={{ height: 22 }} />
      </div>
      {streamingStatus && (
        <span className="min-w-0 break-words text-xs" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
          {streamingStatus}
        </span>
      )}
    </div>
  );
}

export function J4Room({
  messages,
  sendMessage,
  uploadVoiceMemo,
  pendingDecisionsCount,
}: {
  messages: Message[];
  sendMessage: (formData: FormData) => void;
  uploadVoiceMemo: (formData: FormData) => Promise<{ transcript: string; audioUrl: string } | undefined>;
  pendingDecisionsCount: number;
}) {
  const currentPath = "/j4/room";
  const [localMessages, setLocalMessages] = useState<Message[]>(messages);
  const [streamingStatus, setStreamingStatus] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  // "The room should capture what J4 understands" (Sean) — Phase 1 scope:
  // real, already-existing capability only (route.ts's own "done" event
  // already carries the same changes: string[] diff-list StoreMessage
  // persists — see extractChangeList's own comment in messageChanges.ts —
  // just read directly off the live stream instead of waiting on a
  // page refresh). No new backend, no new capture tool (create_task stays
  // explicitly out of scope for this phase).
  const [capturedEntries, setCapturedEntries] = useState<string[]>([]);
  const [voiceMemoStatus, setVoiceMemoStatus] = useState<string | null>(null);
  const voiceMemoPlaceholderRef = useRef<{ userId: string; assistantId: string } | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const messageInputRef = useRef<HTMLTextAreaElement>(null);
  const audioUrlInputRef = useRef<HTMLInputElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);

  // "Initially, it's primarily you and J4... once the conversation begins,
  // the avatar can shrink and move toward the top" (Sean). A real
  // continuation of an existing conversation (the Workspace's own
  // StoreMessage history) opens already "started" — the hero-arrival
  // moment is specifically for a genuinely fresh conversation, not shown
  // out of place mid-relationship.
  const hasStarted = localMessages.length > 0;

  async function sendViaServerAction(formData: FormData, rollBackOptimisticEntries: () => void) {
    const result = await callGenesisAction(() => Promise.resolve(sendMessage(formData)));
    if (!result.ok) {
      setStreamingStatus(null);
      setSendError(result.message);
      rollBackOptimisticEntries();
    }
  }

  // The same reconciliation check as J4Workspace.tsx's own
  // tryRecoverPersistedReply — a dead connection no longer aborts
  // generation or persistence server-side (app/api/chat/route.ts's own
  // emit()), so a disconnect here must check whether the real reply
  // already landed before ever telling the owner to resend.
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
    const audioUrl = (formData.get("audioUrl") as string | null) || null;
    if (audioUrlInputRef.current) audioUrlInputRef.current.value = "";

    const optimisticUserId = `optimistic-user-${Date.now()}`;
    const assistantId = `optimistic-assistant-${Date.now()}`;
    const rollBackOptimisticEntries = () =>
      setLocalMessages((prev) => prev.filter((m) => m.id !== optimisticUserId && m.id !== assistantId));

    const requestId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const tStart = Date.now();

    flushSync(() => {
      setLocalMessages((prev) => [
        ...prev,
        { id: optimisticUserId, role: "user", content: text, changes: audioUrl ? { audioUrl } : null },
        { id: assistantId, role: "assistant", content: "", changes: null },
      ]);
      setStreamingStatus("J4 received your message…");
    });

    let response: Response;
    try {
      response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, requestId, audioUrl: audioUrl ?? undefined }),
      });
    } catch {
      setStreamingStatus("J4 is working on a complete response — this can take a little longer…");
      await sendViaServerAction(formData, rollBackOptimisticEntries);
      return;
    }

    if (!response.ok || !response.body) {
      setStreamingStatus("J4 is working on a complete response — this can take a little longer…");
      await sendViaServerAction(formData, rollBackOptimisticEntries);
      return;
    }

    try {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let sawDone = false;
      let sawFallback = false;
      let fallbackReason: "edit_store_content" | null = null;

      readLoop: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as
            | { type: "padding" }
            | { type: "status"; text: string }
            | { type: "token"; delta: string }
            | { type: "done"; changes: string[] | null }
            | { type: "fallback"; reason?: "edit_store_content" }
            | { type: "error"; message: string };

          if (event.type === "padding") {
            continue;
          } else if (event.type === "status") {
            setStreamingStatus(event.text);
          } else if (event.type === "token") {
            flushSync(() => {
              setStreamingStatus(null);
              setLocalMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: m.content + event.delta } : m)));
            });
            await nextPaint();
          } else if (event.type === "done") {
            sawDone = true;
            setStreamingStatus(null);
            if (event.changes && event.changes.length > 0) {
              const changes = event.changes;
              setCapturedEntries((prev) => [...prev, ...changes]);
            }
          } else if (event.type === "fallback") {
            sawFallback = true;
            fallbackReason = event.reason ?? null;
            break readLoop;
          } else if (event.type === "error") {
            setStreamingStatus(null);
            setSendError(event.message);
            rollBackOptimisticEntries();
            return;
          }
        }
      }

      if (sawFallback) {
        setStreamingStatus("J4 is working on a complete response — this can take up to a minute…");
        if (fallbackReason) formData.set("preClassifiedTool", fallbackReason);
        await sendViaServerAction(formData, rollBackOptimisticEntries);
        return;
      }

      if (!sawDone) {
        setStreamingStatus("Checking whether that finished…");
        const recovered = await tryRecoverPersistedReply(assistantId, tStart);
        setStreamingStatus(null);
        if (!recovered) {
          setSendError("Lost the live connection before seeing J4 finish — it may still complete on its own. Reload in a moment to check.");
          rollBackOptimisticEntries();
        }
      }
    } catch (err) {
      unstable_rethrow(err);
      setStreamingStatus("Checking whether that finished…");
      const recovered = await tryRecoverPersistedReply(assistantId, tStart);
      setStreamingStatus(null);
      if (!recovered) {
        setSendError("Connection interrupted — J4 may have kept working. Reload to check before sending that again.");
        rollBackOptimisticEntries();
      }
    } finally {
      setStreamingStatus(null);
    }
  }

  function handleVoiceMemoStart() {
    const userId = `optimistic-voice-user-${Date.now()}`;
    const assistantId = `optimistic-voice-assistant-${Date.now()}`;
    voiceMemoPlaceholderRef.current = { userId, assistantId };
    flushSync(() => {
      setLocalMessages((prev) => [
        ...prev,
        { id: userId, role: "user", content: "Recorded a voice memo", changes: null },
        { id: assistantId, role: "assistant", content: "", changes: null },
      ]);
      setVoiceMemoStatus("Transcribing your voice memo…");
    });
  }

  function clearVoiceMemoPlaceholder() {
    const placeholder = voiceMemoPlaceholderRef.current;
    voiceMemoPlaceholderRef.current = null;
    setVoiceMemoStatus(null);
    if (placeholder) {
      setLocalMessages((prev) => prev.filter((m) => m.id !== placeholder.userId && m.id !== placeholder.assistantId));
    }
  }

  function sendVoiceMemo(transcript: string, audioUrl: string) {
    clearVoiceMemoPlaceholder();
    if (messageInputRef.current) messageInputRef.current.value = transcript;
    if (audioUrlInputRef.current) audioUrlInputRef.current.value = audioUrl;
    formRef.current?.requestSubmit();
  }

  return (
    <form
      ref={formRef}
      action={handleSend}
      className="fixed inset-0 z-[100] flex w-full flex-col overflow-x-hidden text-[#f4f2fb]"
      style={{ backgroundColor: GENESIS_ATMOSPHERE.bg }}
    >
      <input type="hidden" name="currentPath" value={currentPath} />
      <input type="hidden" name="audioUrl" ref={audioUrlInputRef} />

      {/* Minimal header — no category rail, no status dot, no store-name
          identity strip. Just the exit control and a quiet reference to
          decisions already waiting in the Workspace (Phase 1's own
          "displaying the reusable information we already have available",
          not a duplicate approval UI). */}
      <div className="flex shrink-0 items-center justify-between gap-3 px-5 py-3 pt-[calc(0.75rem+env(safe-area-inset-top))]">
        <p className="text-sm font-medium" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
          J4 Room
        </p>
        <div className="flex shrink-0 items-center gap-2">
          {pendingDecisionsCount > 0 && (
            <span
              className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium"
              style={{ backgroundColor: "rgba(251,191,36,0.12)", color: "#fbbf24" }}
              title="Waiting for your decision in the Workspace"
            >
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" aria-hidden="true" />
              {pendingDecisionsCount} waiting in Workspace
            </span>
          )}
          <Link
            href="/j4"
            aria-label="Back to J4 Workspace"
            className="-m-2 shrink-0 p-2 text-[rgba(244,242,251,0.62)] hover:text-[#f4f2fb]"
          >
            ✕
          </Link>
        </div>
      </div>

      {/* "Initially, it's primarily you and J4... once the conversation
          begins, the avatar can shrink and move toward the top" (Sean).
          One persistent avatar element — its wrapper's own layout classes
          and the avatar's own size class both change with hasStarted,
          rather than two separately-mounted avatars in two JSX branches
          (which would unmount/remount on the first message and make
          "transition-all duration-500" below a no-op, not a real shrink). */}
      <div
        className={
          hasStarted
            ? "flex shrink-0 flex-col items-center justify-center gap-2 py-2 transition-all duration-500"
            : "flex flex-1 flex-col items-center justify-center gap-6 px-8 py-8 text-center transition-all duration-500"
        }
      >
        <GenesisAvatar className={`${hasStarted ? GENESIS_AVATAR_SIZE.inline : GENESIS_AVATAR_SIZE.arrival} transition-all duration-500 ease-out`} />
        {!hasStarted && (
          <div>
            <p className="text-lg font-medium text-[#f4f2fb]">Talk to J4</p>
            <p className="mt-1.5 text-sm" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
              Say what&apos;s on your mind — J4&apos;s listening.
            </p>
          </div>
        )}
      </div>

      {hasStarted && (
        <>
          <div ref={messageListRef} className="min-h-0 w-full min-w-0 max-w-full flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-5 py-2">
            <div className="flex w-full min-w-0 max-w-full flex-col divide-y" style={{ borderColor: GENESIS_ATMOSPHERE.border }}>
              {localMessages.map((m, i) => {
                const isLastMessage = i === localMessages.length - 1;
                const isStreamingPlaceholder = isLastMessage && m.role === "assistant" && m.content === "";
                const audioUrl = extractAudioUrl(m.changes);
                const imageUrl = extractImageUrl(m.changes);
                return (
                  <div key={m.id} data-message-id={m.id} className="min-w-0 w-full max-w-full py-3 first:pt-0">
                    <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
                      {m.role === "user" ? "You" : "J4"}
                    </p>
                    {isStreamingPlaceholder ? (
                      <RoomResponseIndicator streamingStatus={streamingStatus ?? voiceMemoStatus} />
                    ) : audioUrl ? (
                      <div className="mt-1">
                        <audio controls src={audioUrl} className="w-full max-w-sm" />
                        {m.content && (
                          <p className="mt-1.5 break-words text-sm text-[#f4f2fb]" data-role="content">
                            {m.content}
                          </p>
                        )}
                      </div>
                    ) : imageUrl ? (
                      <div className="mt-1">
                        <a
                          href={imageUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-block overflow-hidden rounded-lg border"
                          style={{ borderColor: GENESIS_ATMOSPHERE.border }}
                          aria-label="View full-size image"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element -- same reasoning as J4Workspace.tsx's identical image: Vercel Blob is an arbitrary per-deployment host next/image can't optimize without ongoing config */}
                          <img src={imageUrl} alt="" className="max-h-48" />
                        </a>
                        {m.content && (
                          <p className="mt-1.5 break-words text-sm text-[#f4f2fb]" data-role="content">
                            {m.content}
                          </p>
                        )}
                      </div>
                    ) : (
                      <p className="whitespace-pre-wrap break-words text-sm text-[#f4f2fb]" data-role="content">
                        {m.content}
                      </p>
                    )}
                    {/* J4 Voice Output (2026-08-08) — see J4Workspace.tsx's
                        identical usage; same shared control, same gating. */}
                    {m.role === "assistant" && !isStreamingPlaceholder && m.content && (
                      <J4SpeakButton text={m.content} />
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {capturedEntries.length > 0 && (
            <div className="shrink-0 border-t px-5 py-3" style={{ borderColor: GENESIS_ATMOSPHERE.border }}>
              <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
                J4 Captured
              </p>
              <ul className="mt-1.5 flex flex-col gap-1 text-sm text-[#f4f2fb]">
                {capturedEntries.map((entry, i) => (
                  <li key={i}>• {entry}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {sendError && (
        <div className="shrink-0 px-5 pt-2 text-sm text-red-400">{sendError}</div>
      )}

      {/* Composer — always docked at the bottom, same in both beats. Before
          the conversation starts, the mic is size="large" (the primary
          action in an otherwise empty room); once it's underway, it steps
          back to default size alongside the now-primary text field. Kept
          as ONE VoiceMemoButton instance throughout (never two separately-
          mounted buttons) — see VoiceMemoButton.tsx's own streamRef
          comment for why remounting it would silently drop the cached mic
          stream and could truncate an in-progress recording. */}
      <div
        className="w-full min-w-0 max-w-full shrink-0 overflow-x-hidden border-t px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-2"
        style={{ borderColor: GENESIS_ATMOSPHERE.border }}
      >
        <div className="flex min-w-0 w-full max-w-full items-end gap-2 rounded-2xl border-2 p-1.5 pl-4"
          style={{ borderColor: GENESIS_ATMOSPHERE.violet, backgroundColor: GENESIS_ATMOSPHERE.bgElevated }}
        >
          <textarea
            ref={messageInputRef}
            name="message"
            placeholder="Talk to J4…"
            rows={1}
            required
            onFocus={() => setGenesisComposing(true)}
            onBlur={() => setGenesisComposing(false)}
            className="min-w-0 max-h-40 min-h-[2.75rem] flex-1 resize-none bg-transparent py-2.5 text-[15px] text-[#f4f2fb] placeholder:text-[rgba(244,242,251,0.45)] focus:outline-none"
          />
          <VoiceMemoButton
            uploadVoiceMemo={uploadVoiceMemo}
            currentPath={currentPath}
            // The immersive Room is a destination the owner entered on
            // purpose, so it keeps the redirecting completion it has always
            // had. Only the persistent layer must never move anyone.
            surface="room"
            onStart={handleVoiceMemoStart}
            onFailure={(message) => {
              clearVoiceMemoPlaceholder();
              setSendError(message);
            }}
            onTranscribed={sendVoiceMemo}
            size={hasStarted ? "default" : "large"}
          />
          <SubmitButton
            pendingText="→"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#8b7cf6] text-lg text-white shadow-[0_0_20px_-6px_rgba(139,124,246,0.6)] transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            <span aria-hidden="true">→</span>
            <span className="sr-only">Send to J4</span>
          </SubmitButton>
        </div>
      </div>
    </form>
  );
}
