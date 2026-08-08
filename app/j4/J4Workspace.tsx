"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import { useFormStatus } from "react-dom";
import { upload as blobUpload } from "@vercel/blob/client";
import { deriveAssessmentState } from "@/lib/dashboard/genesisState";
import { GENESIS_ATMOSPHERE } from "@/lib/dashboard/genesisAtmosphere";
import { setGenesisComposing, setGenesisWorking } from "@/lib/dashboard/genesisActivity";
import { USAGE_CEILING_MESSAGE } from "@/lib/dashboard/genesisModelMessages";
import { callGenesisAction } from "@/lib/dashboard/submitGenesisAction";
import { ALLOWED_CONTENT_TYPES, MAX_UPLOAD_BYTES } from "@/lib/businessAssets/uploadAssetFile";
import { ALLOWED_VOICE_MEMO_CONTENT_TYPES, MAX_VOICE_MEMO_BYTES } from "@/lib/voice/voiceMemoFile";
import { SubmitButton } from "@/app/dashboard/SubmitButton";
import { GenesisAvatar } from "@/app/dashboard/GenesisAvatar";

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

// Real bug, found via live testing (2026-08-08): J4 could see and
// correctly describe an uploaded photo, but the owner only ever saw
// "Uploaded a photo: X.png" — the real image URL lived on a separate
// BusinessRecord row, unreachable from the conversation itself.
// uploadBusinessAssetFromChat (app/dashboard/ai-actions.ts) now writes it
// into the same StoreMessage.changes field the diff-list case below
// already uses, as { imageUrl } — the two shapes are distinguished here
// rather than adding a second upload/reference system.
function extractChangeList(changes: unknown): string[] | null {
  return Array.isArray(changes) ? changes.filter((c): c is string => typeof c === "string") : null;
}
function extractImageUrl(changes: unknown): string | null {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return null;
  const value = (changes as Record<string, unknown>).imageUrl;
  return typeof value === "string" ? value : null;
}
// J4 Voice Memos — the same {changes} convention, one more real shape.
// Unlike a photo's filename (disposable, purely secondary), a voice
// memo's message content IS its real transcript — the primary channel
// J4 is actually responding to — so rendering treats audioUrl
// differently from imageUrl (see the message-list JSX below).
function extractAudioUrl(changes: unknown): string | null {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return null;
  const value = (changes as Record<string, unknown>).audioUrl;
  return typeof value === "string" ? value : null;
}

interface J4Signals {
  hasUrgentIssue: boolean;
  hasPendingDecision: boolean;
  hasOpportunity: boolean;
  hasCuriosity: boolean;
}

// Portal categories (Sean, 2026-08-08) — "J4 should be able to organize
// things into meaningful categories such as Tasks, Ideas, Decisions,
// Information, and Conversation rather than everything simply appearing
// as chat messages." Each maps to a real, already-existing model
// (page.tsx resolves all four server-side) — never a fabricated grouping:
// Tasks = open Task rows; Decisions = pending ApprovalRequest rows; Ideas
// = "opportunity"-state GenesisObservation rows; Information = "urgent"-
// state GenesisObservation rows plus "explanation"-kind CognitiveOutput
// rows (both are things J4 has concluded and wants the owner to know,
// distinct from an opportunity or a thing needing approval).
type Category = "conversation" | "tasks" | "ideas" | "decisions" | "information";

interface TaskItem {
  id: string;
  title: string;
  summary: string;
  href: string | null;
  priority: string;
}
interface DecisionItem {
  id: string;
  summary: string;
  createdAt: string;
  href: string | null;
}
interface IdeaItem {
  id: string;
  summary: string;
  href: string | null;
}
interface InformationItem {
  id: string;
  summary: string;
  href: string | null;
  kind: "urgent" | "curiosity";
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
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      {/* Multi-file upload foundation (Sean, 2026-08-08) — "the owner
          needs to be able to select/upload multiple photos and eventually
          large batches of business material... design the upload
          architecture so it isn't fundamentally limited to one file per
          interaction." Each file still gets its own real ingest/classify/
          StoreMessage turn (uploadBusinessAssetFromChat, unchanged) —
          this is real per-file processing run N times from one selection,
          not a fabricated "batch" that just uploads bytes. Associating
          uploads with an active task instead of asking what each one is
          (Sean's explicit next step) is real Phase B work, not done here. */}
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (files.length === 0) return;

          const validFiles: { file: File; extension: string }[] = [];
          const problems: string[] = [];
          for (const file of files) {
            const extension = ALLOWED_CONTENT_TYPES[file.type];
            if (!extension) {
              problems.push(`${file.name} (unsupported type)`);
              continue;
            }
            if (file.size > MAX_UPLOAD_BYTES) {
              problems.push(`${file.name} (over 8MB)`);
              continue;
            }
            validFiles.push({ file, extension });
          }
          if (validFiles.length === 0) {
            onFailure(
              problems.length > 0
                ? `Couldn't upload: ${problems.join(", ")}.`
                : "Please choose a PNG, JPEG, WebP, HEIC, or PDF file."
            );
            return;
          }

          startTransition(async () => {
            for (let i = 0; i < validFiles.length; i++) {
              const { file, extension } = validFiles[i];
              const isLast = i === validFiles.length - 1;
              setProgress({ current: i + 1, total: validFiles.length });
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
                // Only the batch's last file redirects/reopens the
                // conversation — see uploadBusinessAssetFromChat's own
                // comment on why every earlier one must not (Next only
                // ever lets one redirect actually navigate per submit).
                if (!isLast) formData.set("skipRedirect", "true");
                return uploadAsset(formData);
              });
              if (!result.ok) {
                setProgress(null);
                onFailure(result.message);
                return;
              }
            }
            setProgress(null);
            if (problems.length > 0) onFailure(`Uploaded ${validFiles.length} file(s). Couldn't upload: ${problems.join(", ")}.`);
          });
        }}
      />
      <button
        type="button"
        disabled={isPending}
        onClick={() => inputRef.current?.click()}
        aria-label={label}
        title={label}
        className="flex h-10 min-w-[2.5rem] shrink-0 items-center justify-center gap-1 rounded-lg px-1.5 text-base text-[rgba(244,242,251,0.62)] transition hover:bg-white/[.06] disabled:opacity-50"
      >
        {isPending ? (
          <>
            <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
            {progress && progress.total > 1 && <span className="text-xs">{progress.current}/{progress.total}</span>}
          </>
        ) : (
          icon
        )}
      </button>
    </>
  );
}

// J4 Voice Memos (2026-08-08) — the fourth "Add to J4" control, alongside
// photos/documents. Recording (MediaRecorder) is architecturally distinct
// from UploadAssetButton's file-picker flow above, so this is a separate
// component rather than a variant of it — but the resulting blob still
// goes through the exact same @vercel/blob/client upload() mechanism
// before uploadVoiceMemo (a real Server Action, app/dashboard/ai-actions.ts)
// ever sees it, same as every other real upload in this app.
const MAX_RECORDING_SECONDS = 600; // 10 minutes — "speak naturally and at length" (Sean), not unbounded

function pickSupportedVoiceMemoMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/mpeg"];
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return null;
}

function VoiceMemoButton({
  uploadVoiceMemo,
  currentPath,
  onFailure,
}: {
  uploadVoiceMemo: (formData: FormData) => void;
  currentPath: string;
  onFailure: (message: string) => void;
}) {
  const [isPending, startTransition] = useTransition();
  const [isRecording, setIsRecording] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Real hardware/browser resource — released the instant the component
  // unmounts (leaving /j4) even if a recording is somehow still active,
  // not left running in the background.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== "inactive") recorder.stop();
    };
  }, []);

  const isAvailable =
    typeof window !== "undefined" && typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";
  // Honest absence, not a disabled-and-confusing control — same principle
  // UploadAssetButton's own graceful-fallback comment already follows.
  if (!isAvailable) return null;

  function finishRecording() {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setIsRecording(false);
    recorder.stop();
  }

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = pickSupportedVoiceMemoMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      chunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        const contentType = (recorder.mimeType || "audio/webm").split(";")[0];
        const extension = ALLOWED_VOICE_MEMO_CONTENT_TYPES[contentType] ?? "webm";
        const blob = new Blob(chunksRef.current, { type: contentType });
        chunksRef.current = [];
        if (blob.size === 0) return;
        if (blob.size > MAX_VOICE_MEMO_BYTES) {
          onFailure("That recording is too long to upload — please keep voice memos under 20MB.");
          return;
        }
        startTransition(async () => {
          const result = await callGenesisAction(async () => {
            const uploaded = await blobUpload(`voice-memos/${randomAssetKey()}.${extension}`, blob, {
              access: "public",
              handleUploadUrl: "/api/blob/business-asset-upload",
              contentType,
            });
            const formData = new FormData();
            formData.set("blobUrl", uploaded.url);
            formData.set("originalFilename", `voice-memo.${extension}`);
            formData.set("contentType", contentType);
            formData.set("currentPath", currentPath);
            return uploadVoiceMemo(formData);
          });
          if (!result.ok) onFailure(result.message);
        });
      };

      mediaRecorderRef.current = recorder;
      recorder.start();
      setIsRecording(true);
      setElapsedSeconds(0);
      timerRef.current = setInterval(() => {
        setElapsedSeconds((s) => {
          const next = s + 1;
          if (next >= MAX_RECORDING_SECONDS) finishRecording();
          return next;
        });
      }, 1000);
    } catch {
      onFailure("Couldn't access your microphone — check your browser's permission for this site.");
    }
  }

  return (
    <button
      type="button"
      disabled={isPending}
      onClick={() => (isRecording ? finishRecording() : startRecording())}
      aria-label={isRecording ? "Stop recording" : "Record a voice memo"}
      title={isRecording ? "Stop recording" : "Record a voice memo"}
      className={
        isRecording
          ? "flex h-10 min-w-[2.5rem] shrink-0 items-center justify-center gap-1.5 rounded-lg bg-red-500/15 px-2 text-base text-red-400"
          : "flex h-10 min-w-[2.5rem] shrink-0 items-center justify-center rounded-lg px-1.5 text-base text-[rgba(244,242,251,0.62)] transition hover:bg-white/[.06] disabled:opacity-50"
      }
    >
      {isPending ? (
        <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
      ) : isRecording ? (
        <>
          <span className="relative inline-flex h-2 w-2 shrink-0" aria-hidden="true">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
          </span>
          <span className="text-xs tabular-nums">
            {Math.floor(elapsedSeconds / 60)}:{String(elapsedSeconds % 60).padStart(2, "0")}
          </span>
        </>
      ) : (
        "🎙️"
      )}
    </button>
  );
}

function taskPriorityDotClassName(priority: string): string {
  if (priority === "FAILED") return "bg-red-500";
  if (priority === "WARNING") return "bg-amber-400";
  return "bg-purple-500"; // "opportunity"
}

// Deliberately plain rows in a document-like list, not cards mimicking
// GenesisDomicile/ObservationsPanel's own framed-widget treatment — this
// is the Portal's own category browser, not a second copy of a dashboard
// panel. A title is only shown for Tasks (the one category with a real,
// separate title field); everything else leads with its summary.
function CategoryRow({
  title,
  summary,
  href,
  dotClassName,
}: {
  title?: string;
  summary: string;
  href: string | null;
  dotClassName: string;
}) {
  const inner = (
    <div className="flex items-start gap-2.5">
      <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${dotClassName}`} aria-hidden="true" />
      <div className="min-w-0">
        {title && <p className="text-sm font-medium text-[#f4f2fb]">{title}</p>}
        <p className={`text-sm ${title ? "mt-0.5 text-[rgba(244,242,251,0.62)]" : "text-[#f4f2fb]"}`}>{summary}</p>
      </div>
    </div>
  );
  const rowClassName = "block rounded-lg px-2 py-2.5 transition hover:bg-white/[.04]";
  return href ? (
    <a href={href} className={rowClassName}>
      {inner}
    </a>
  ) : (
    <div className={rowClassName}>{inner}</div>
  );
}

function CategoryEmptyState({ label }: { label: string }) {
  return <p className="px-2 py-2.5 text-sm text-[rgba(244,242,251,0.5)]">Nothing in {label} right now.</p>;
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
  uploadVoiceMemo,
  hasUrgentIssue,
  hasPendingDecision,
  hasOpportunity,
  hasCuriosity,
  tasks,
  decisions,
  ideas,
  information,
}: {
  storeName: string;
  messages: Message[];
  sendMessage: (formData: FormData) => void;
  uploadAsset: (formData: FormData) => void;
  uploadVoiceMemo: (formData: FormData) => void;
  tasks: TaskItem[];
  decisions: DecisionItem[];
  ideas: IdeaItem[];
  information: InformationItem[];
} & J4Signals) {
  const currentPath = "/j4";
  const [activeCategory, setActiveCategory] = useState<Category>("conversation");
  const overallState = deriveAssessmentState({ hasUrgentIssue, hasPendingDecision, hasOpportunity, hasCuriosity });

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

  async function sendViaServerAction(formData: FormData, rollBackOptimisticEntries: () => void) {
    const result = await callGenesisAction(() => Promise.resolve(sendMessage(formData)));
    // ok:true is never actually reached here for the real redirecting
    // action (sendStoreMessage ends in redirect(), thrown as Next's own
    // NEXT_REDIRECT and re-thrown past this by callGenesisAction's own
    // unstable_rethrow) — this only fires for a genuine, non-redirecting
    // failure, which is the only case that should roll back the
    // optimistic entries now (see handleSend's own comment on why the
    // fallback path itself no longer does).
    if (!result.ok) {
      setStreamingStatus(null);
      setSendError(result.message);
      rollBackOptimisticEntries();
    }
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

    // Instant, honest acknowledgment — real production finding (Sean's
    // mother, 2026-08-08, testing live): "Simple request and no answer."
    // The request genuinely was received the moment this line runs; this
    // is not a server round trip away, it's true immediately.
    setStreamingStatus("J4 received your message…");

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
      // Falling back to the slower path is not itself a failure — keep
      // the owner's message and J4's placeholder visible (see the
      // sawFallback branch below for why this changed) rather than
      // wiping the screen while the fallback runs.
      setStreamingStatus("J4 is working on a complete response — this can take a little longer…");
      await sendViaServerAction(formData, rollBackOptimisticEntries);
      return;
    }
    reportDiag(requestId, tStart, "client_fetch_resolved", { ok: response.ok, status: response.status, hasBody: !!response.body });

    if (!response.ok || !response.body) {
      inFlightRequestRef.current = null;
      setStreamingStatus("J4 is working on a complete response — this can take a little longer…");
      await sendViaServerAction(formData, rollBackOptimisticEntries);
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
        // Real bug, confirmed via production trace (2026-08-08): this used
        // to roll back the optimistic entries immediately, wiping the
        // owner's own message and J4's placeholder from view for the
        // entire ~40s the fallback path can take — the owner's screen went
        // completely blank, indistinguishable from nothing having
        // happened. A fallback is an expected, honest "this needs the
        // slower path," not a failure — keep both rows visible and say so
        // plainly; only a genuine failure inside sendViaServerAction rolls
        // them back now.
        setStreamingStatus("J4 is working on a complete response — this can take up to a minute…");
        await sendViaServerAction(formData, rollBackOptimisticEntries);
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
      // Real bug, confirmed via production trace (2026-08-08): when the
      // server signals a fallback (see the sawFallback branch above),
      // sendViaServerAction calls the real "use server" sendMessage
      // action directly — which ends in redirect() (applyGenesisMessageToStore),
      // thrown as Next's own NEXT_REDIRECT control-flow signal, not a real
      // error. That signal must propagate all the way to Next's router
      // (see submitGenesisAction.ts's own comment on this exact pattern);
      // this catch previously swallowed it as if the read loop itself had
      // failed, running reconciliation for a request that was actually
      // still completing normally, just slowly. unstable_rethrow detects
      // and re-throws Next's own signals; it's a no-op for a real error,
      // so the reconciliation logic below is unchanged for genuine failures.
      unstable_rethrow(err);
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
    // Conversation always tracks the newest turn; the other categories are
    // plain browsable lists, not a live feed — switching into one of them
    // should land at the top, not wherever Conversation's scroll happened
    // to be (they share one scroll container across category switches).
    el.scrollTop = activeCategory === "conversation" ? el.scrollHeight : 0;
  }, [localMessages.length, lastMessageContentLength, activeCategory]);

  const categoryTabs: { key: Category; label: string; count: number }[] = [
    { key: "conversation", label: "Conversation", count: 0 },
    { key: "tasks", label: "Tasks", count: tasks.length },
    { key: "ideas", label: "Ideas", count: ideas.length },
    { key: "decisions", label: "Decisions", count: decisions.length },
    { key: "information", label: "Information", count: information.length },
  ];

  return (
    <form
      action={handleSend}
      className="fixed inset-0 z-[100] flex flex-col text-[#f4f2fb]"
      style={{ backgroundColor: GENESIS_ATMOSPHERE.bg }}
    >
      <input type="hidden" name="currentPath" value={currentPath} />

      {/* Identity strip — "J4 identity should be prominent and official at
          the top" (Sean). A real avatar (state/activity-aware, the same
          component used everywhere else J4 needs presence), not a plain
          status dot; the Portal's own name and who it's partnering with,
          not a question implying this is only for asking things. */}
      <div
        className="flex shrink-0 items-center justify-between gap-3 border-b px-5 py-3 pt-[calc(0.75rem+env(safe-area-inset-top))]"
        style={{ borderColor: GENESIS_ATMOSPHERE.border, backgroundColor: GENESIS_ATMOSPHERE.bgElevated }}
      >
        <div className="flex min-w-0 items-center gap-3">
          <GenesisAvatar state={overallState} className="h-10 w-10 shrink-0" />
          <div className="min-w-0">
            <p className="text-base font-semibold tracking-wide text-[#f4f2fb]">J4</p>
            <p className="truncate text-xs" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
              Business Partner for {storeName}
            </p>
          </div>
          <J4WorkingPublisher />
        </div>
        <Link
          href="/dashboard"
          aria-label="Return to dashboard"
          className="-m-2 shrink-0 p-2 text-[rgba(244,242,251,0.62)] hover:text-[#f4f2fb]"
        >
          ✕
        </Link>
      </div>

      {/* Category rail — "organize into meaningful categories... rather
          than everything simply appearing as chat messages" (Sean). Every
          count is real data resolved server-side (page.tsx), never a
          placeholder; Conversation has no count of its own (it's the
          default view, not a queue to clear). */}
      <div
        className="flex shrink-0 gap-1 overflow-x-auto border-b px-5 py-2"
        style={{ borderColor: GENESIS_ATMOSPHERE.border }}
      >
        {categoryTabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveCategory(tab.key)}
            className={
              activeCategory === tab.key
                ? "shrink-0 rounded-full bg-[#8b7cf6] px-3 py-1.5 text-xs font-medium text-white"
                : "shrink-0 rounded-full px-3 py-1.5 text-xs font-medium text-[rgba(244,242,251,0.62)] transition hover:bg-white/[.06]"
            }
          >
            {tab.label}
            {tab.count > 0 && <span className="ml-1.5 opacity-80">{tab.count}</span>}
          </button>
        ))}
      </div>

      {/* Center region — conversation reads as a workspace log (role
          labels, no bubbles, no left/right alternation), every other
          category as a plain browsable list of real records. */}
      <div ref={messageListRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">
        {activeCategory === "conversation" ? (
          localMessages.length === 0 ? (
            <div className="text-sm" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
              <p className="font-medium text-[#f4f2fb]">Your business partner, always paying attention.</p>
              <p className="mt-1">
                Ask J4 to change something, give it instructions, or just check in — it&apos;s already watching for
                what needs you, and will tell you what it&apos;s noticed or handled.
              </p>
            </div>
          ) : (
            <div className="flex flex-col divide-y" style={{ borderColor: GENESIS_ATMOSPHERE.border }}>
              {localMessages.map((m, i) => {
                const changeList = extractChangeList(m.changes);
                const imageUrl = extractImageUrl(m.changes);
                const audioUrl = extractAudioUrl(m.changes);
                const isStreamingPlaceholder = i === localMessages.length - 1 && m.role === "assistant" && m.content === "";
                return (
                  <div key={m.id} className="py-3 first:pt-0" style={{ borderColor: GENESIS_ATMOSPHERE.border }}>
                    <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
                      {m.role === "user" ? "You" : "J4"}
                    </p>
                    {isStreamingPlaceholder ? (
                      // "explicit work states... visibly communicate that
                      // J4 is working" (Sean, 2026-08-08, after his
                      // mother's real test read a static "thinking" line
                      // as "no answer"). Not italic/muted metadata — this
                      // is the primary channel telling the owner J4
                      // received the request and is actively on it;
                      // streamingStatus already carries real, evolving
                      // per-phase text from the server (or the fallback
                      // path's own honest "this can take a minute").
                      <div className="mt-1 flex items-center gap-2 text-sm text-[#f4f2fb]">
                        <span className="relative inline-flex h-2 w-2 shrink-0" aria-hidden="true">
                          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#8b7cf6] opacity-75" />
                          <span className="relative inline-flex h-2 w-2 rounded-full bg-[#8b7cf6]" />
                        </span>
                        <span>{streamingStatus ?? "J4 is working on this…"}</span>
                      </div>
                    ) : imageUrl ? (
                      // The image is the primary representation — the
                      // filename stays as secondary metadata below it, not
                      // the other way around (Sean, 2026-08-08).
                      <div className="mt-1">
                        <a
                          href={imageUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-block overflow-hidden rounded-lg border"
                          style={{ borderColor: GENESIS_ATMOSPHERE.border }}
                          aria-label="View full-size image"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element -- same reasoning as DashboardShell's own product-image rendering: Vercel Blob is an arbitrary per-deployment host next/image can't optimize without ongoing config */}
                          <img src={imageUrl} alt={m.content} className="block max-h-64 max-w-[260px] object-cover" />
                        </a>
                        <p className="mt-1 text-xs" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
                          {m.content}
                        </p>
                      </div>
                    ) : audioUrl ? (
                      // Unlike a photo, the transcript IS the real message
                      // — "the audio itself is a first-class Portal input,
                      // not merely converted into a disposable transcript"
                      // (Sean, 2026-08-08). The recording plays inline
                      // above it, full size text below, not a muted
                      // caption.
                      <div className="mt-1">
                        <audio src={audioUrl} controls preload="metadata" className="h-10 w-full max-w-xs" />
                        <p className="mt-1.5 text-sm leading-relaxed text-[#f4f2fb]">{m.content}</p>
                      </div>
                    ) : (
                      <p className="mt-1 text-sm leading-relaxed text-[#f4f2fb]">{m.content}</p>
                    )}
                    {changeList && changeList.length > 0 && (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs hover:text-[#f4f2fb]" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
                          See what changed
                        </summary>
                        <ul className="mt-1 list-disc pl-4 text-xs" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
                          {changeList.map((c, i) => (
                            <li key={i}>{c}</li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </div>
                );
              })}
            </div>
          )
        ) : activeCategory === "tasks" ? (
          tasks.length === 0 ? (
            <CategoryEmptyState label="Tasks" />
          ) : (
            <div className="flex flex-col divide-y" style={{ borderColor: GENESIS_ATMOSPHERE.border }}>
              {tasks.map((t) => (
                <CategoryRow key={t.id} title={t.title} summary={t.summary} href={t.href} dotClassName={taskPriorityDotClassName(t.priority)} />
              ))}
            </div>
          )
        ) : activeCategory === "ideas" ? (
          ideas.length === 0 ? (
            <CategoryEmptyState label="Ideas" />
          ) : (
            <div className="flex flex-col divide-y" style={{ borderColor: GENESIS_ATMOSPHERE.border }}>
              {ideas.map((o) => (
                <CategoryRow key={o.id} summary={o.summary} href={o.href} dotClassName="bg-purple-500" />
              ))}
            </div>
          )
        ) : activeCategory === "decisions" ? (
          decisions.length === 0 ? (
            <CategoryEmptyState label="Decisions" />
          ) : (
            <div className="flex flex-col divide-y" style={{ borderColor: GENESIS_ATMOSPHERE.border }}>
              {decisions.map((d) => (
                <CategoryRow key={d.id} summary={d.summary} href={d.href} dotClassName="bg-amber-400" />
              ))}
            </div>
          )
        ) : information.length === 0 ? (
          <CategoryEmptyState label="Information" />
        ) : (
          <div className="flex flex-col divide-y" style={{ borderColor: GENESIS_ATMOSPHERE.border }}>
            {information.map((i) => (
              <CategoryRow key={i.id} summary={i.summary} href={i.href} dotClassName={i.kind === "urgent" ? "bg-red-500" : "bg-teal-400"} />
            ))}
          </div>
        )}
      </div>

      {showConfirmCeiling && previousUserMessage && (
        <div className="shrink-0 border-t px-5 pt-3" style={{ borderColor: GENESIS_ATMOSPHERE.border }}>
          <ConfirmCeilingOverride
            sendMessage={sendMessage}
            previousUserMessage={previousUserMessage}
            currentPath={currentPath}
            onFailure={setSendError}
          />
        </div>
      )}

      {sendError && (
        <div className="shrink-0 border-t px-5 pt-3 text-sm text-red-400" style={{ borderColor: GENESIS_ATMOSPHERE.border }}>
          {sendError}
        </div>
      )}

      {/* Command area — real mobile testing (Sean, 2026-08-08) found the
          original single-row bar read as "an add/attachment control," not
          "the place I talk to J4" — the camera/document icons competed
          visually with the field itself. Redesigned into two clearly
          unequal rows: a small, muted "Add to J4" strip (secondary,
          labeled so the icons are never ambiguous) sits above a full-
          width, strongly-bordered field that is unmistakably the primary
          input, ending in a distinct circular send control. Two-second
          glance test this now needs to pass: this is J4 / this is where I
          talk to J4 / these buttons add files / that arrow sends it. */}
      <div
        className="shrink-0 border-t px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-2"
        style={{ borderColor: GENESIS_ATMOSPHERE.border }}
      >
        <div className="mb-1.5 flex items-center gap-1.5">
          <span className="pl-1 text-[10px] font-semibold uppercase tracking-wide" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
            Add to J4
          </span>
          <UploadAssetButton
            label="Add photos"
            icon="📷"
            accept="image/png,image/jpeg,image/webp,image/heic,image/heif"
            uploadAsset={uploadAsset}
            currentPath={currentPath}
            onFailure={setSendError}
          />
          <UploadAssetButton
            label="Add documents"
            icon="📄"
            accept="application/pdf"
            uploadAsset={uploadAsset}
            currentPath={currentPath}
            onFailure={setSendError}
          />
          <VoiceMemoButton uploadVoiceMemo={uploadVoiceMemo} currentPath={currentPath} onFailure={setSendError} />
        </div>
        <div
          className="flex items-end gap-2 rounded-2xl border-2 p-1.5 pl-4"
          style={{ borderColor: GENESIS_ATMOSPHERE.violet, backgroundColor: GENESIS_ATMOSPHERE.bgElevated }}
        >
          <textarea
            name="message"
            placeholder="Talk to J4 — ask, instruct, or tell J4 what you're working on…"
            rows={1}
            required
            onFocus={() => setGenesisComposing(true)}
            onBlur={() => setGenesisComposing(false)}
            className="max-h-40 min-h-[2.75rem] flex-1 resize-none bg-transparent py-2.5 text-[15px] text-[#f4f2fb] placeholder:text-[rgba(244,242,251,0.45)] focus:outline-none"
          />
          <SubmitButton
            pendingText="…"
            laterPendingText="…"
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
