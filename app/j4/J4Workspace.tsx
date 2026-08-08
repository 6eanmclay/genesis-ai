"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { unstable_rethrow, useRouter } from "next/navigation";
import { useFormStatus, flushSync } from "react-dom";
import { upload as blobUpload } from "@vercel/blob/client";
import { deriveAssessmentState, GENESIS_STATE_META } from "@/lib/dashboard/genesisState";
import { GENESIS_ATMOSPHERE } from "@/lib/dashboard/genesisAtmosphere";
import { setGenesisComposing, setGenesisWorking } from "@/lib/dashboard/genesisActivity";
import { USAGE_CEILING_MESSAGE } from "@/lib/dashboard/genesisModelMessages";
import { callGenesisAction } from "@/lib/dashboard/submitGenesisAction";
import { mapWithConcurrency } from "@/lib/concurrency";
import { ALLOWED_CONTENT_TYPES, MAX_UPLOAD_BYTES } from "@/lib/businessAssets/uploadAssetFile";
import { ALLOWED_VOICE_MEMO_CONTENT_TYPES, MAX_VOICE_MEMO_BYTES } from "@/lib/voice/voiceMemoFile";
import { SubmitButton } from "@/app/dashboard/SubmitButton";
import { GenesisAvatar } from "@/app/dashboard/GenesisAvatar";
import { GENESIS_AVATAR_SIZE } from "@/lib/dashboard/genesisAvatarSize";

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
// J4 Portal batch intake — a grouped multi-photo upload (uploadPhotoBatchFromChat)
// carries the whole set on one user-turn StoreMessage, rendered as a
// thumbnail grid rather than N separate message rows.
function extractImageUrls(changes: unknown): string[] | null {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return null;
  const value = (changes as Record<string, unknown>).imageUrls;
  return Array.isArray(value) && value.every((v) => typeof v === "string") ? (value as string[]) : null;
}
// "Give the owner useful choices... J4 should not assume the purpose of
// the photos" (Sean, 2026-08-08) — real, tappable options on the
// assistant's own batch-intake reply; extractChangeList's array shape
// already exists for a different purpose (diff lists), so this checks
// for the same {quickReplies} object shape imageUrl/audioUrl use, not a
// second overload of the plain-array case.
function extractQuickReplies(changes: unknown): string[] | null {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return null;
  const value = (changes as Record<string, unknown>).quickReplies;
  return Array.isArray(value) && value.every((v) => typeof v === "string") ? (value as string[]) : null;
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

// Real production investigation, round 2 (2026-08-08) — "do not assume
// the previous flushSync fix solved it," and it didn't alone. flushSync
// forces React to commit synchronously, but it does NOT force the
// browser to actually paint — if one reader.read() call returns a
// buffer containing several NDJSON "token" lines (routine network/OS
// coalescing, not a bug), the for-loop below processes all of them in
// one uninterrupted synchronous JS execution; flushSync re-renders after
// each one, but the browser's rendering engine can't paint any of those
// intermediate frames until the JS thread actually yields back to it.
// The result is indistinguishable from no streaming at all, even though
// every earlier layer (server emission, network delivery, React state)
// is genuinely correct. Awaiting one real animation frame after each
// token's flushSync gives the browser that yield point — the standard
// technique real streaming-text UIs use to make token-by-token delivery
// actually visible, not just technically true.
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== "undefined") {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
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
  uploadAssetBatch,
  currentPath,
  onFailure,
}: {
  label: string;
  icon: string;
  accept: string;
  uploadAsset: (formData: FormData) => void;
  // J4 Portal batch intake (2026-08-08) — optional, and only ever passed
  // for the photo button today ("documents eventually," Sean's own
  // words, not built yet). When present AND more than one valid file is
  // selected, every file still uploads to Blob individually (unchanged),
  // but instead of looping uploadAsset per file (immediate classify+
  // reply each time), this calls uploadAssetBatch exactly once with the
  // full list — see uploadPhotoBatchFromChat's own comment for why.
  // A single file, or no batch handler at all, keeps the original loop
  // byte-for-byte unchanged.
  uploadAssetBatch?: (formData: FormData) => void;
  currentPath: string;
  onFailure: (message: string) => void;
}) {
  const [isPending, startTransition] = useTransition();
  const [progress, setProgress] = useState<{ succeeded: number; total: number } | null>(null);
  // Resilient batch upload architecture (2026-08-08) — real production
  // finding: a 100+ photo selection sent every file to Blob at once via
  // Promise.all, which discards every already-succeeded result the
  // instant a single file fails — the owner sees a generic error with no
  // way to tell what actually made it, and has to reselect everything to
  // try again. failedBatchFiles holds the real File objects (not just
  // their names) specifically so "Retry" can re-attempt exactly those,
  // no re-picking required — see mapWithConcurrency's own comment for the
  // underlying pool mechanic. Non-null only once a batch run has actually
  // produced at least one failure; the review panel it renders blocks the
  // final server submission until the owner decides, so a real failure
  // is never silently swept away by an immediate redirect.
  const [failedBatchFiles, setFailedBatchFiles] = useState<{ file: File; extension: string; error: string }[] | null>(null);
  const [readyBatchFiles, setReadyBatchFiles] = useState<{ blobUrl: string; originalFilename: string; contentType: string }[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  async function uploadOneToBlob(entry: { file: File; extension: string }) {
    const blob = await blobUpload(`assets/${randomAssetKey()}.${entry.extension}`, entry.file, {
      access: "public",
      handleUploadUrl: "/api/blob/business-asset-upload",
      contentType: entry.file.type,
    });
    return { blobUrl: blob.url, originalFilename: entry.file.name, contentType: entry.file.type };
  }

  // A real concurrency cap, not "all N at once" — each Blob upload also
  // invokes a serverless function to authenticate it (see
  // app/api/blob/business-asset-upload/route.ts), so throttling this is
  // what actually keeps a 100+ file selection from overwhelming both the
  // phone's own network stack and that function's concurrent invocations.
  const BATCH_UPLOAD_CONCURRENCY = 4;

  async function runBatchUpload(entries: { file: File; extension: string }[]) {
    setProgress({ succeeded: 0, total: entries.length });
    let succeededSoFar = 0;
    const newlySucceeded: { blobUrl: string; originalFilename: string; contentType: string }[] = [];
    const stillFailing: { file: File; extension: string; error: string }[] = [];

    await mapWithConcurrency(entries, BATCH_UPLOAD_CONCURRENCY, uploadOneToBlob, (index, result) => {
      if (result.ok) {
        succeededSoFar += 1;
        newlySucceeded.push(result.value);
      } else {
        stillFailing.push({
          file: entries[index].file,
          extension: entries[index].extension,
          error: result.error instanceof Error ? result.error.message : "Upload failed",
        });
      }
      setProgress({ succeeded: succeededSoFar, total: entries.length });
    });

    return { newlySucceeded, stillFailing };
  }

  async function submitReadyFiles(files: { blobUrl: string; originalFilename: string; contentType: string }[]) {
    if (files.length === 0) return;
    const result = await callGenesisAction(async () => {
      const formData = new FormData();
      formData.set("files", JSON.stringify(files));
      formData.set("currentPath", currentPath);
      return uploadAssetBatch!(formData);
    });
    if (!result.ok) onFailure(result.message);
  }

  return (
    <div className="relative">
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
            // Resilient batch upload (2026-08-08) — a real multi-file
            // selection goes through one grouped upload+one owner-facing
            // turn instead of N individual classify+reply turns, throttled
            // and fault-tolerant rather than one all-or-nothing
            // Promise.all. See runBatchUpload's own comment.
            if (uploadAssetBatch && validFiles.length > 1) {
              const { newlySucceeded, stillFailing } = await runBatchUpload(validFiles);
              setProgress(null);
              if (stillFailing.length === 0) {
                await submitReadyFiles(newlySucceeded);
                if (problems.length > 0) onFailure(`Uploaded ${validFiles.length} file(s). Couldn't upload: ${problems.join(", ")}.`);
                return;
              }
              // Real failures — hold here rather than auto-submitting and
              // redirecting, which would sweep the review panel away
              // before the owner ever saw it. readyBatchFiles carries
              // what's already safely uploaded across a retry pass so
              // "Retry" only re-attempts what's actually still failing.
              setReadyBatchFiles(newlySucceeded);
              setFailedBatchFiles(stillFailing);
              return;
            }

            for (let i = 0; i < validFiles.length; i++) {
              const { file, extension } = validFiles[i];
              const isLast = i === validFiles.length - 1;
              setProgress({ succeeded: i, total: validFiles.length });
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
                // Resilient sequential upload (2026-08-08) — a real
                // failure on one document (or single-file photo) used to
                // abort every file after it, even ones that would have
                // succeeded. Recorded and skipped instead; the rest of
                // the selection still gets a real attempt. The LAST
                // attempted file still needs to be the one that redirects
                // (see isLast's own comment above) — a failure on what
                // was meant to be the last file falls through the loop
                // normally, so problems below still reports it honestly.
                problems.push(`${file.name} (${result.message})`);
                continue;
              }
            }
            setProgress(null);
            if (problems.length > 0) onFailure(`Uploaded ${validFiles.length - problems.length} of ${validFiles.length} file(s). Couldn't upload: ${problems.join(", ")}.`);
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
            {progress && progress.total > 1 && (
              <span className="text-xs tabular-nums">{progress.succeeded}/{progress.total}</span>
            )}
          </>
        ) : (
          icon
        )}
      </button>

      {/* Absolutely positioned, matching VoiceMemoButton's own recovery-
          panel pattern — never affects the composer row's own layout. */}
      {failedBatchFiles && failedBatchFiles.length > 0 && (
        <div
          className="absolute bottom-full left-0 z-10 mb-2 w-72 rounded-xl border border-amber-500/25 p-3 text-xs shadow-lg"
          style={{ backgroundColor: GENESIS_ATMOSPHERE.bgElevated }}
        >
          <p className="font-medium text-amber-400">
            {readyBatchFiles.length} of {readyBatchFiles.length + failedBatchFiles.length} uploaded — {failedBatchFiles.length} didn&apos;t make it
          </p>
          <ul className="mt-1.5 max-h-24 overflow-y-auto text-[rgba(244,242,251,0.62)]">
            {failedBatchFiles.map((f) => (
              <li key={f.file.name} className="truncate">{f.file.name}</li>
            ))}
          </ul>
          <div className="mt-2.5 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={isPending}
              onClick={() => {
                startTransition(async () => {
                  const { newlySucceeded, stillFailing } = await runBatchUpload(
                    failedBatchFiles.map(({ file, extension }) => ({ file, extension }))
                  );
                  setProgress(null);
                  const nowReady = [...readyBatchFiles, ...newlySucceeded];
                  if (stillFailing.length === 0) {
                    setFailedBatchFiles(null);
                    setReadyBatchFiles([]);
                    await submitReadyFiles(nowReady);
                    return;
                  }
                  setReadyBatchFiles(nowReady);
                  setFailedBatchFiles(stillFailing);
                });
              }}
              className="rounded-full bg-amber-500/20 px-3 py-1 text-xs font-medium text-amber-400 hover:bg-amber-500/30 disabled:opacity-50"
            >
              Retry {failedBatchFiles.length}
            </button>
            {readyBatchFiles.length > 0 && (
              <button
                type="button"
                disabled={isPending}
                onClick={() => {
                  startTransition(async () => {
                    const toSubmit = readyBatchFiles;
                    setFailedBatchFiles(null);
                    setReadyBatchFiles([]);
                    await submitReadyFiles(toSubmit);
                  });
                }}
                className="rounded-full border border-black/[.08] px-3 py-1 text-xs text-zinc-300 hover:bg-white/[.06] disabled:opacity-50"
              >
                Continue with {readyBatchFiles.length}
              </button>
            )}
            <button
              type="button"
              disabled={isPending}
              onClick={() => {
                setFailedBatchFiles(null);
                setReadyBatchFiles([]);
              }}
              className="rounded-full px-3 py-1 text-xs text-[rgba(244,242,251,0.5)] hover:bg-white/[.06] disabled:opacity-50"
            >
              Discard
            </button>
          </div>
        </div>
      )}
    </div>
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

// Real Android finding (Sean's mother, 2026-08-08): tapping the mic showed
// the generic "check your browser's permission" error, but no native
// permission dialog ever appeared — unlike iOS. This isn't a bug in the
// reasoning, it's real, documented cross-platform behavior: Android has
// TWO permission layers (the browser app's own OS-level microphone
// permission, plus the per-site browser permission), and if either is
// already blocked, getUserMedia() rejects with NotAllowedError
// immediately, silently, with no in-page prompt at all — nothing JS can
// do makes the browser re-show a dialog it has already decided not to
// show again. The only real recovery is telling the owner exactly where
// to go fix it, and the "where" differs by platform. A coarse User-Agent
// check is standard, accepted practice for this kind of messaging-only
// branch (never used for anything security-relevant).
function describeMicPermissionFix(): string {
  if (typeof navigator === "undefined") {
    return "Check your browser's site settings for this page, allow microphone access, then try again.";
  }
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) {
    return "Tap the lock or info icon next to the address bar, then Permissions → Microphone → Allow. If it's still blocked, check your phone's own Settings → Apps → " +
      "(your browser) → Permissions → Microphone.";
  }
  if (/iPhone|iPad|iPod/i.test(ua)) {
    return "Open the Settings app → Safari → Microphone, and set this website to Allow. Or in Safari, tap \"aA\" in the address bar → Website Settings → Microphone → Allow.";
  }
  return "Check your browser's site settings for this page, allow microphone access, then try again.";
}

function VoiceMemoButton({
  uploadVoiceMemo,
  currentPath,
  onStart,
  onFailure,
  onTranscribed,
  size = "default",
}: {
  uploadVoiceMemo: (formData: FormData) => Promise<{ transcript: string; audioUrl: string } | undefined>;
  currentPath: string;
  // Priority 3 — J4 Voice Responsiveness (2026-08-08). Fires the instant
  // recording stops, before the blob upload or transcription call even
  // begins — this is the real "immediate acknowledgment" moment Sean's
  // audit found missing: previously nothing told the owner anything was
  // happening until the ENTIRE upload+transcribe round trip finished.
  onStart: () => void;
  onFailure: (message: string) => void;
  // 2026-08-08 — voice-memo streaming convergence: uploadVoiceMemo no
  // longer drives J4's reply itself (see its own comment in
  // app/dashboard/ai-actions.ts) — it only transcribes and hands the real
  // text back here, for the parent to submit through the exact same
  // streaming send path a typed message uses.
  onTranscribed: (transcript: string, audioUrl: string) => void;
  // Priority 4 — Just Talk (2026-08-08, scope frozen). Same component,
  // same recording/upload/transcribe logic — only the button's own visual
  // size changes for Just Talk's mic-primary layout, so there is exactly
  // one voice-memo implementation, never a second "big mic" component.
  size?: "default" | "large";
}) {
  const [isPending, startTransition] = useTransition();
  const [isRecording, setIsRecording] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  // Real Android finding (2026-08-08) — a nontechnical owner stuck at a
  // one-line error message has no obvious next step. When getUserMedia()
  // rejects as an access-denied case (see describeMicPermissionFix's own
  // comment), this drives a real, dismissible recovery panel instead of
  // just another toast — platform-specific instructions plus a real "Try
  // again" that re-attempts getUserMedia() (works for the case permission
  // was just fixed in Settings, harmless no-op otherwise).
  const [micBlocked, setMicBlocked] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Real bug (Sean, 2026-08-08, real iPhone Safari screenshot): every
  // recording called getUserMedia() fresh and then, on stop, called
  // track.stop() on it — which fully releases the hardware mic, not just
  // this recording. The NEXT tap then had no live stream to reuse and
  // had to request a brand new one, which is exactly the "tap Allow, tap
  // Record again, get asked again" symptom. A granted getUserMedia
  // permission is meant to be reusable for the page's whole lifetime;
  // the fix is to actually reuse the stream instead of tearing it down
  // each time, not to build any custom permission UI over Apple's own
  // native prompt.
  const streamRef = useRef<MediaStream | null>(null);

  // Real hardware/browser resource — released the instant the component
  // unmounts (leaving /j4) even if a recording is somehow still active,
  // not left running in the background. This is now the ONLY place the
  // stream's tracks get stopped — not after every individual recording.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== "inactive") recorder.stop();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
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
    setMicBlocked(false);
    try {
      // Reuse the already-granted stream whenever it's still live —
      // this is the real fix: only ever call getUserMedia() again if
      // there's genuinely no usable stream (first-ever tap, or a track
      // that's died for some real reason), never unconditionally.
      let stream = streamRef.current;
      const hasLiveTrack = stream?.getAudioTracks().some((track) => track.readyState === "live") ?? false;
      if (!stream || !hasLiveTrack) {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamRef.current = stream;
      }
      const mimeType = pickSupportedVoiceMemoMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      chunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        // Deliberately NOT stopping the stream's tracks here anymore —
        // see streamRef's own comment on why. The mic stays held
        // (matching how a native app's own "record again" affordance
        // behaves) until this component unmounts.
        const contentType = (recorder.mimeType || "audio/webm").split(";")[0];
        const extension = ALLOWED_VOICE_MEMO_CONTENT_TYPES[contentType] ?? "webm";
        const blob = new Blob(chunksRef.current, { type: contentType });
        chunksRef.current = [];
        if (blob.size === 0) return;
        if (blob.size > MAX_VOICE_MEMO_BYTES) {
          onFailure("That recording is too long to upload — please keep voice memos under 20MB.");
          return;
        }
        onStart();
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
          if (!result.ok) {
            onFailure(result.message);
          } else if (result.value) {
            onTranscribed(result.value.transcript, result.value.audioUrl);
          }
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
    } catch (err) {
      // Real Android finding (2026-08-08) — branch by the real DOMException
      // name getUserMedia() actually rejects with, not one generic message
      // for every failure. NotAllowedError is the "already blocked, no
      // prompt will ever show again" case — that's the one that needs a
      // real recovery panel, not a toast that vanishes with nothing the
      // owner can act on.
      const name = err instanceof DOMException ? err.name : "";
      if (name === "NotAllowedError") {
        setMicBlocked(true);
      } else if (name === "NotFoundError") {
        onFailure("No microphone was found on this device.");
      } else if (name === "NotReadableError") {
        onFailure("Your microphone is being used by another app — close it and try again.");
      } else {
        onFailure("Couldn't access your microphone — check your browser's permission for this site.");
      }
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        disabled={isPending}
        onClick={() => (isRecording ? finishRecording() : startRecording())}
        aria-label={isRecording ? "Stop recording" : micBlocked ? "Microphone blocked — tap for help" : "Record a voice memo"}
        title={isRecording ? "Stop recording" : micBlocked ? "Microphone blocked — tap for help" : "Record a voice memo"}
        className={
          size === "large"
            ? isRecording
              ? "flex h-20 w-20 shrink-0 flex-col items-center justify-center gap-1 rounded-full bg-red-500/15 text-red-400 shadow-[0_0_28px_-6px_rgba(239,68,68,0.5)]"
              : micBlocked
                ? "flex h-20 w-20 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-3xl text-amber-500 transition hover:bg-amber-500/25"
                : "flex h-20 w-20 shrink-0 items-center justify-center rounded-full text-3xl text-white shadow-[0_0_28px_-6px_rgba(139,124,246,0.6)] transition-opacity hover:opacity-90 disabled:opacity-50"
            : isRecording
              ? "flex h-10 min-w-[2.5rem] shrink-0 items-center justify-center gap-1.5 rounded-lg bg-red-500/15 px-2 text-base text-red-400"
              : micBlocked
                ? "flex h-10 min-w-[2.5rem] shrink-0 items-center justify-center rounded-lg bg-amber-500/15 px-1.5 text-base text-amber-500 transition hover:bg-amber-500/25"
                : "flex h-10 min-w-[2.5rem] shrink-0 items-center justify-center rounded-lg px-1.5 text-base text-[rgba(244,242,251,0.62)] transition hover:bg-white/[.06] disabled:opacity-50"
        }
        style={size === "large" && !isRecording && !micBlocked ? { backgroundColor: GENESIS_ATMOSPHERE.violet } : undefined}
      >
        {isPending ? (
          <span
            className={
              size === "large"
                ? "inline-block h-6 w-6 animate-spin rounded-full border-2 border-current border-t-transparent"
                : "inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
            }
          />
        ) : isRecording ? (
          <>
            <span className={size === "large" ? "relative inline-flex h-3 w-3 shrink-0" : "relative inline-flex h-2 w-2 shrink-0"} aria-hidden="true">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
              <span className={size === "large" ? "relative inline-flex h-3 w-3 rounded-full bg-red-500" : "relative inline-flex h-2 w-2 rounded-full bg-red-500"} />
            </span>
            <span className={size === "large" ? "text-sm tabular-nums" : "text-xs tabular-nums"}>
              {Math.floor(elapsedSeconds / 60)}:{String(elapsedSeconds % 60).padStart(2, "0")}
            </span>
          </>
        ) : micBlocked ? (
          "⚠️"
        ) : (
          "🎙️"
        )}
      </button>

      {/* Absolutely positioned so this never affects the composer row's
          own height/layout — the horizontal-scroll fix stays untouched. */}
      {micBlocked && (
        <div
          className="absolute bottom-full left-0 z-10 mb-2 w-64 rounded-xl border border-amber-500/25 p-3 text-xs shadow-lg"
          style={{ backgroundColor: GENESIS_ATMOSPHERE.bgElevated }}
        >
          <p className="font-medium text-amber-400">Microphone is blocked for this site</p>
          <p className="mt-1.5 text-[rgba(244,242,251,0.75)]">{describeMicPermissionFix()}</p>
          <div className="mt-2.5 flex gap-2">
            <button
              type="button"
              onClick={() => startRecording()}
              className="rounded-full bg-amber-500/20 px-3 py-1 text-xs font-medium text-amber-400 hover:bg-amber-500/30"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => setMicBlocked(false)}
              className="rounded-full px-3 py-1 text-xs text-[rgba(244,242,251,0.62)] hover:bg-white/[.06]"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
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
      <div className="min-w-0 flex-1">
        {title && <p className="break-words text-sm font-medium text-[#f4f2fb]">{title}</p>}
        <p className={`break-words text-sm ${title ? "mt-0.5 text-[rgba(244,242,251,0.62)]" : "text-[#f4f2fb]"}`}>{summary}</p>
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

// Real production investigation (2026-08-08) — "confirm the response-row
// indicator actually mounts in the DOM... confirm whether it is being
// hidden/clipped/off-screen... confirm the browser actually paints"
// (Sean, after two prior fixes changed nothing visible). A dedicated
// component specifically so it gets its own real mount lifecycle
// (useEffect fires exactly once, the instant React actually commits this
// into the DOM) — the inline version this replaced had no way to
// independently confirm it existed at all, distinct from React's
// virtual state saying it should. requestMeta is null until handleSend's
// own flushSync commits it (see that function's own comment on why the
// very first paint needed the same fix the token-by-token updates
// already got) — this component simply doesn't render at all until
// there's a real request to correlate its trace with.
function J4ResponseIndicator({
  requestMeta,
  streamingStatus,
}: {
  requestMeta: { requestId: string; tStart: number } | null;
  streamingStatus: string | null;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!requestMeta) return;
    const { requestId, tStart } = requestMeta;
    const el = ref.current;
    if (!el) {
      reportDiag(requestId, tStart, "indicator_mount_no_dom_node");
      return;
    }
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    reportDiag(requestId, tStart, "indicator_mounted", {
      rectTop: rect.top,
      rectLeft: rect.left,
      rectWidth: rect.width,
      rectHeight: rect.height,
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
      inViewport: rect.top >= 0 && rect.top < window.innerHeight && rect.width > 0 && rect.height > 0,
    });
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        reportDiag(requestId, tStart, "indicator_paint_confirmed");
      });
    });
    // Deliberately requestMeta.requestId only — a new turn (new
    // requestId) is the only thing that should re-run this; the ref
    // itself never changes identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestMeta?.requestId]);

  return (
    <div ref={ref} className="mt-1 flex min-w-0 items-center gap-2">
      {/* J4 response indicator — four-bar signal. "Four simple vertical
          bars of increasing height... animate sequentially left to
          right... the four bars represent J4" (Sean) — an equalizer/
          soundwave shape, deliberately meant to carry through into J4's
          own spoken-response voice later, not just text. */}
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

export function J4Workspace({
  storeName,
  messages,
  sendMessage,
  uploadAsset,
  uploadPhotoBatch,
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
  uploadPhotoBatch: (formData: FormData) => void;
  uploadVoiceMemo: (formData: FormData) => Promise<{ transcript: string; audioUrl: string } | undefined>;
  tasks: TaskItem[];
  decisions: DecisionItem[];
  ideas: IdeaItem[];
  information: InformationItem[];
} & J4Signals) {
  const currentPath = "/j4";
  const router = useRouter();
  const [activeCategory, setActiveCategory] = useState<Category>("conversation");
  // Priority 4 — Just Talk (2026-08-08, scope frozen). A presentation-only
  // toggle over the exact same conversation/pipeline — no new route, no
  // new data, no change to handleSend/VoiceMemoButton/streamingStatus or
  // anything server-side. Off by default: the category rail, Add-to-J4
  // upload row, and header status dot are the Portal's normal chrome;
  // Just Talk simply hides them and gives the mic primary visual weight,
  // per Sean's own explicit calls on both open questions from the frozen
  // scope doc.
  const [justTalk, setJustTalk] = useState(false);
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
  // Priority 3 — J4 Voice Responsiveness (2026-08-08). A separate status
  // channel from streamingStatus (which is reserved for a real /api/chat
  // turn) covering the window handleSend never used to reach at all: the
  // real network upload + Server Action round trip + Whisper call between
  // "recording stopped" and "transcript ready." voiceMemoPlaceholderRef
  // tracks the optimistic message pair so it can be removed the instant
  // the real turn (with the actual transcript) takes its place — never
  // left behind as an orphaned empty bubble.
  const [voiceMemoStatus, setVoiceMemoStatus] = useState<string | null>(null);
  const voiceMemoPlaceholderRef = useRef<{ userId: string; assistantId: string } | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  // Quick-reply buttons (batch intake) submit through the real <form>
  // (formRef.requestSubmit()), not by calling handleSend directly as a
  // second, plain call path — same real action, dispatched the same way
  // typing and pressing send already does, not a shortcut around it.
  const formRef = useRef<HTMLFormElement>(null);
  const messageInputRef = useRef<HTMLTextAreaElement>(null);
  // Voice-memo streaming convergence (2026-08-08) — carries a transcribed
  // memo's real audioUrl across the same form submission sendQuickReply's
  // own hidden currentPath field already uses, so handleSend can persist
  // it on the turn's user StoreMessage without a second send mechanism.
  const audioUrlInputRef = useRef<HTMLInputElement>(null);

  // Directly tests "is the component/page lifecycle killing the request" —
  // set for the duration of a real turn so a real disconnect/backgrounding
  // event can be reported precisely, not just generically.
  const inFlightRequestRef = useRef<{ requestId: string; tStart: number } | null>(null);
  // Real production investigation (2026-08-08) — "we need evidence of
  // where the response disappears between state and pixels" (Sean).
  // requestId/tStart are otherwise only ever local variables inside
  // handleSend; lifted into real state so the render below can hand the
  // SAME correlation ids to J4ResponseIndicator's own DOM-mount/paint
  // instrumentation — one continuous, correlatable trace from "the
  // owner tapped send" through to "the browser actually painted a
  // pixel," not two disconnected logs.
  const [activeRequestMeta, setActiveRequestMeta] = useState<{ requestId: string; tStart: number } | null>(null);
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

  // Real bug (Sean, 2026-08-08): a rename approved elsewhere (e.g. the
  // Brand/Identity page an "always_ask"-tier change like this one really
  // requires — see update_store_identity's own authorizationTier) left
  // the Portal header stale even after the earlier router.refresh()-on-
  // turn-completion fix. Confirmed against this project's own bundled
  // Next.js docs (staleTimes.md): a dynamic route's client-side page
  // cache defaults to 0s (not cached) for regular navigation, but Next's
  // separate back/forward cache deliberately serves a stale render
  // anyway "to prevent layout shift and losing scroll position" — and
  // that path bypasses staleTimes entirely. router.refresh() on a
  // completed /j4 turn only ever covers staying on this page the whole
  // time; it does nothing for "left /j4 to approve something elsewhere
  // (or just backgrounded the tab), came back." pageshow's own
  // event.persisted is the real, standard browser signal for exactly a
  // bfcache-style restoration; visibilitychange covers the same backgrounded-tab
  // case defensively, since which one actually fires can vary by
  // browser/OS. Cheap either way — just one more RSC fetch, not an AI call.
  useEffect(() => {
    function refreshOnReturn() {
      router.refresh();
    }
    function handlePageShow(event: PageTransitionEvent) {
      if (event.persisted) refreshOnReturn();
    }
    function handleVisibilityChange() {
      if (document.visibilityState === "visible") refreshOnReturn();
    }
    window.addEventListener("pageshow", handlePageShow);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("pageshow", handlePageShow);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [router]);

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
    // Voice-memo streaming convergence (2026-08-08) — read once, then
    // clear immediately so a voice memo's audioUrl never leaks onto the
    // NEXT, unrelated typed submit; sendVoiceMemo below is the only thing
    // that ever sets this field.
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
    inFlightRequestRef.current = { requestId, tStart };

    // Real production investigation (2026-08-08) — "confirm when the
    // pending/thinking state becomes true" and "we need evidence of
    // where the response disappears between state and pixels" (Sean).
    // handleSend runs as a <form action={handleSend}> body — React 19
    // treats that whole execution as an implicit transition, and every
    // setState call inside it (including this one, previously) was NOT
    // guaranteed to commit/paint before the async work below continues.
    // The token-by-token updates later in this function already learned
    // this lesson (flushSync, added after the first failed streaming
    // fix) — this exact same gap existed here too, on the FIRST paint
    // that's supposed to show the four-bar indicator at all, and had
    // never been closed. flushSync forces React to synchronously commit
    // and lets the browser paint before the fetch/network work starts.
    reportDiag(requestId, tStart, "optimistic_placeholder_intent");
    flushSync(() => {
      setLocalMessages((prev) => [
        ...prev,
        { id: optimisticUserId, role: "user", content: text, changes: audioUrl ? { audioUrl } : null },
        { id: assistantId, role: "assistant", content: "", changes: null },
      ]);
      setActiveRequestMeta({ requestId, tStart });
      // Instant, honest acknowledgment — real production finding (Sean's
      // mother, 2026-08-08, testing live): "Simple request and no
      // answer." The request genuinely was received the moment this
      // line runs; this is not a server round trip away, it's true
      // immediately.
      setStreamingStatus("J4 received your message…");
    });
    reportDiag(requestId, tStart, "optimistic_placeholder_committed");

    reportDiag(requestId, tStart, "client_fetch_start");

    let response: Response;
    try {
      response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, requestId, audioUrl: audioUrl ?? undefined }),
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
      // J4 command execution fix (2026-08-08) — carries route.ts's own
      // "this was edit_store_content" determination through to the
      // fallback Server Action, so applyGenesisMessageToStore doesn't
      // re-run an independent second classification of the same message
      // that could genuinely disagree with the first (see that function's
      // own preClassifiedTool comment for the real, confirmed risk this
      // closes).
      let fallbackReason: "edit_store_content" | null = null;
      let sawFirstChunk = false;
      let sawFirstToken = false;
      // Real production investigation (2026-08-08) — "do not infer that
      // streaming works because the final response arrives quickly." A
      // real, concrete, testable hypothesis this specifically checks: the
      // server can genuinely emit N separate small chunks while the
      // network/OS still coalesces them into fewer, larger reader.read()
      // calls — if several "token" lines arrive within ONE read(), the
      // for-loop below calls setLocalMessages several times inside one
      // synchronous tick, and React 18's automatic batching collapses
      // them into a single paint. That would look exactly like "pasted
      // all at once" on a real phone despite the server, the network
      // transport, and the parsing all being genuinely correct. readIndex
      // ties every token to the specific read() call it arrived in —
      // tokensThisRead > 1 on the same readIndex, repeated across most of
      // the response, is the direct signature of that failure mode.
      // flushSync below is the standard, always-safe fix for exactly this
      // (forces each token's DOM update to actually paint before the loop
      // continues) — applied now alongside the instrumentation rather
      // than waiting for a second test round-trip to confirm the theory
      // before fixing it, since forcing more frequent paint is never
      // wrong even if this isn't the actual bottleneck.
      let readIndex = 0;
      let tokenIndex = 0;
      // "confirm each streamed token causes the displayed message state
      // to update" AND that the update reaches real pixels, not just
      // React's virtual state (Sean, 2026-08-08) — tracks the length
      // React's state SHOULD now hold after each flushSync, to compare
      // directly against what querySelector finds in the real DOM a
      // moment later.
      let accumulatedContentLength = 0;

      readLoop: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        readIndex += 1;
        const thisReadIndex = readIndex;
        let tokensThisRead = 0;
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
            | { type: "fallback"; reason?: "edit_store_content" }
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
            tokenIndex += 1;
            tokensThisRead += 1;
            accumulatedContentLength += event.delta.length;
            reportDiag(requestId, tStart, "client_token_applied", { i: tokenIndex, readIndex: thisReadIndex, tokensThisRead, len: event.delta.length });
            flushSync(() => {
              setStreamingStatus(null);
              setLocalMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: m.content + event.delta } : m)));
            });
            // Real bridge check, state -> real DOM: read the actual
            // rendered text back out of the page immediately after the
            // flushSync commit above claims to have applied it. If
            // domTextLength never catches up to expectedLength, React's
            // own state is updating but isn't reaching the screen — a
            // completely different bug than anything upstream of the
            // client. data-message-id/data-role="content" (added to the
            // message row JSX below) are what make this selector real.
            const domEl = messageListRef.current?.querySelector(`[data-message-id="${assistantId}"] [data-role="content"]`);
            reportDiag(requestId, tStart, "client_token_dom_check", {
              i: tokenIndex,
              expectedLength: accumulatedContentLength,
              domTextLength: domEl?.textContent?.length ?? null,
              domFound: !!domEl,
            });
            // Real paint confirmation: requestAnimationFrame only ever
            // fires immediately before the browser paints. A callback
            // scheduled inside another already-fired rAF callback is a
            // real, standard signal that a genuine paint cycle completed
            // between the two — the closest a page can get to "the pixel
            // actually changed" without the (unavailable-here) Paint
            // Timing API.
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                reportDiag(requestId, tStart, "client_token_paint_confirmed", { i: tokenIndex });
              });
            });
            await nextPaint();
          } else if (event.type === "done") {
            sawDone = true;
            reportDiag(requestId, tStart, "client_done_event_received");
            setStreamingStatus(null);
            // Real bug (Sean, 2026-08-08): a rename (or any other real
            // store-content change) executed by J4 left the Portal
            // header showing the old business name — page.tsx's own
            // server-fetched props (storeName, task/decision counts,
            // etc.) only refresh on a real navigation, and most turns
            // here never navigate at all. router.refresh() is Next's own
            // real mechanism for exactly this — re-fetch this route's
            // server data now, reconciled into the same mounted
            // component (localMessages and every other client state
            // untouched) — not a second, hand-rolled cache-busting
            // workaround. Every turn refreshes, not just ones that
            // happen to touch the store name, since any turn could.
            router.refresh();
          } else if (event.type === "fallback") {
            sawFallback = true;
            fallbackReason = event.reason ?? null;
            reportDiag(requestId, tStart, "client_fallback_event_received", { reason: fallbackReason });
            break readLoop;
          } else if (event.type === "error") {
            reportDiag(requestId, tStart, "client_error_event_received", { message: event.message });
            setStreamingStatus(null);
            setSendError(event.message);
            rollBackOptimisticEntries();
            return;
          }
        }
        if (tokensThisRead > 0) {
          reportDiag(requestId, tStart, "client_read_summary", { readIndex: thisReadIndex, byteLength: value?.length ?? 0, tokensThisRead });
        }
      }
      reportDiag(requestId, tStart, "client_stream_summary", { totalReads: readIndex, totalTokensApplied: tokenIndex });

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
        if (fallbackReason) formData.set("preClassifiedTool", fallbackReason);
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
      setActiveRequestMeta(null);
      setStreamingStatus(null);
    }
  }

  // J4 Portal batch intake — a tapped quick-reply ("Organize them", "Tell
  // me what you see", ...) is a real conversational turn, sent through
  // the exact same handleSend pipeline a typed message uses (streaming,
  // optimistic UI, reconciliation, all of it) — not a second, simplified
  // send path just because the text came from a button instead of the
  // keyboard.
  // J4 Portal batch intake — a tapped quick-reply ("Organize them", "Tell
  // me what you see", ...) is a real conversational turn, sent through
  // the exact same real <form>/handleSend pipeline a typed message uses
  // (streaming, optimistic UI, reconciliation, all of it) — via a real
  // form submission (requestSubmit), not a second, direct call path into
  // handleSend, so this stays exactly one real send mechanism.
  function sendQuickReply(text: string) {
    if (messageInputRef.current) messageInputRef.current.value = text;
    formRef.current?.requestSubmit();
  }

  // Priority 3 — J4 Voice Responsiveness (2026-08-08). Fires the instant
  // recording stops — before the blob upload or transcription call even
  // begins — so the owner sees a real acknowledgment in the actual
  // conversation, not just a spinner inside the small record button. Reuses
  // the exact same optimistic-message + flushSync pattern handleSend
  // already uses for the real turn, so the same J4ResponseIndicator bars
  // render immediately, then hand off seamlessly once the transcript lands.
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

  // Clears the placeholder pair above — called both on a real transcript
  // (about to be replaced by handleSend's own real optimistic turn) and on
  // failure (nothing to hand off to, so it must not linger as a dead
  // empty bubble).
  function clearVoiceMemoPlaceholder() {
    const placeholder = voiceMemoPlaceholderRef.current;
    voiceMemoPlaceholderRef.current = null;
    setVoiceMemoStatus(null);
    if (placeholder) {
      setLocalMessages((prev) => prev.filter((m) => m.id !== placeholder.userId && m.id !== placeholder.assistantId));
    }
  }

  // Voice-memo streaming convergence (2026-08-08) — same real <form>
  // submission mechanism as sendQuickReply above (never a second, direct
  // call into handleSend), with the transcript's real audioUrl carried
  // through the hidden field so the turn's user message renders as a
  // playable memo, not plain text, from the very first optimistic paint.
  function sendVoiceMemo(transcript: string, audioUrl: string) {
    clearVoiceMemoPlaceholder();
    if (messageInputRef.current) messageInputRef.current.value = transcript;
    if (audioUrlInputRef.current) audioUrlInputRef.current.value = audioUrl;
    formRef.current?.requestSubmit();
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
      ref={formRef}
      action={handleSend}
      className="fixed inset-0 z-[100] flex w-full flex-col overflow-x-hidden text-[#f4f2fb]"
      style={{ backgroundColor: GENESIS_ATMOSPHERE.bg }}
    >
      <input type="hidden" name="currentPath" value={currentPath} />
      <input type="hidden" name="audioUrl" ref={audioUrlInputRef} />

      {/* Identity strip — "J4 identity should be prominent and official at
          the top" (Sean). A real avatar (activity-aware, the same
          component used everywhere else J4 needs presence); the Portal's
          own name and who it's partnering with, not a question implying
          this is only for asking things.
          Visual polish (2026-08-08) — the avatar itself no longer
          recolors for business-assessment state (Sean: "I don't want the
          avatar changing to red/orange/purple based on state... calm,
          consistent, recognizable every time"). The real signal moves to
          a small corner dot instead — same GENESIS_STATE_META color/label
          language DashboardShell's own nav pills already use, just here
          instead of on the photo. */}
      <div
        className="flex shrink-0 items-center justify-between gap-3 border-b px-5 py-3 pt-[calc(0.75rem+env(safe-area-inset-top))]"
        style={{ borderColor: GENESIS_ATMOSPHERE.border, backgroundColor: GENESIS_ATMOSPHERE.bgElevated }}
      >
        <div className="flex min-w-0 items-center gap-3">
          <div className="relative shrink-0">
            <GenesisAvatar className={GENESIS_AVATAR_SIZE.inline} />
            {/* Just Talk hides the operational status dot — a "something
                needs attention" signal is exactly the management-console
                framing this mode exists to step away from. Nothing about
                the underlying state stops being tracked; it just isn't
                shown here while the owner is just talking. */}
            {overallState !== "idle" && !justTalk && (
              <span
                className={`absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full ${GENESIS_STATE_META[overallState].dotClassName}`}
                style={{ boxShadow: `0 0 0 2px ${GENESIS_ATMOSPHERE.bgElevated}` }}
                aria-label={GENESIS_STATE_META[overallState].label}
                title={GENESIS_STATE_META[overallState].label}
              />
            )}
          </div>
          <div className="min-w-0">
            <p className="text-base font-semibold tracking-wide text-[#f4f2fb]">J4</p>
            <p className="truncate text-xs" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
              Business Partner for {storeName}
            </p>
          </div>
          <J4WorkingPublisher />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* Quiet pending-approval indicator (frozen scope decision) — the
              only new UI a real action gets while in Just Talk. Reuses
              decisions.length, already resolved server-side in page.tsx;
              nothing blocks or interrupts the conversation, and the real
              approval UI still lives exactly where it already does
              (Decisions tab / the relevant dashboard page) once the owner
              exits. */}
          {justTalk && decisions.length > 0 && (
            <span
              className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium"
              style={{ backgroundColor: "rgba(251,191,36,0.12)", color: "#fbbf24" }}
              title="Waiting for your decision — see the Decisions tab in Workspace"
            >
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" aria-hidden="true" />
              {decisions.length} waiting for you
            </span>
          )}
          <button
            type="button"
            onClick={() => {
              // Real edge case: the rail this toggle hides is the only way
              // to switch categories — if the owner was on Tasks/Ideas/
              // Decisions/Information when toggling Just Talk on, they'd be
              // stranded there with no rail to get back to Conversation.
              // Forcing Conversation on every toggle (both directions)
              // sidesteps that entirely rather than tracking "whichever tab
              // was active before."
              setJustTalk((v) => !v);
              setActiveCategory("conversation");
            }}
            aria-pressed={justTalk}
            className={
              justTalk
                ? "shrink-0 rounded-full bg-[#8b7cf6] px-3 py-1.5 text-xs font-medium text-white"
                : "shrink-0 rounded-full px-3 py-1.5 text-xs font-medium text-[rgba(244,242,251,0.62)] transition hover:bg-white/[.06]"
            }
          >
            {justTalk ? "Workspace" : "Just Talk"}
          </button>
          <Link
            href="/dashboard"
            aria-label="Return to dashboard"
            className="-m-2 shrink-0 p-2 text-[rgba(244,242,251,0.62)] hover:text-[#f4f2fb]"
          >
            ✕
          </Link>
        </div>
      </div>

      {/* Category rail — "organize into meaningful categories... rather
          than everything simply appearing as chat messages" (Sean). Every
          count is real data resolved server-side (page.tsx), never a
          placeholder; Conversation has no count of its own (it's the
          default view, not a queue to clear).
          Just Talk hides this rail entirely (frozen scope) — it's the
          single biggest "this is a management console" signal in the
          Portal, present even while just talking. The toggle button
          itself forces activeCategory back to "conversation" on every
          switch (see its own comment) so there's never a state where this
          rail is hidden but a non-Conversation tab is showing. */}
      {!justTalk && (
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
      )}

      {/* Center region — conversation reads as a workspace log (role
          labels, no bubbles, no left/right alternation), every other
          category as a plain browsable list of real records. */}
      <div
        ref={messageListRef}
        className="min-h-0 w-full min-w-0 max-w-full flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-5 py-4"
      >
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
            <div className="flex w-full min-w-0 max-w-full flex-col divide-y" style={{ borderColor: GENESIS_ATMOSPHERE.border }}>
              {localMessages.map((m, i) => {
                const changeList = extractChangeList(m.changes);
                const imageUrl = extractImageUrl(m.changes);
                const imageUrls = extractImageUrls(m.changes);
                const audioUrl = extractAudioUrl(m.changes);
                const isLastMessage = i === localMessages.length - 1;
                // Only ever shown on the most recent turn — an older
                // batch's quick-replies would be stale once the
                // conversation has moved on (see uploadPhotoBatchFromChat's
                // own comment on why this stays real conversational
                // context, not a separate "active batch" flag).
                const quickReplies = m.role === "assistant" && isLastMessage ? extractQuickReplies(m.changes) : null;
                const isStreamingPlaceholder = isLastMessage && m.role === "assistant" && m.content === "";
                return (
                  <div
                    key={m.id}
                    data-message-id={m.id}
                    className="min-w-0 w-full max-w-full py-3 first:pt-0"
                    style={{ borderColor: GENESIS_ATMOSPHERE.border }}
                  >
                    <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
                      {m.role === "user" ? "You" : "J4"}
                    </p>
                    {isStreamingPlaceholder ? (
                      <J4ResponseIndicator requestMeta={activeRequestMeta} streamingStatus={streamingStatus ?? voiceMemoStatus} />
                    ) : imageUrls && imageUrls.length > 0 ? (
                      // Batch intake (2026-08-08) — "the Portal should
                      // display the uploaded photos together in a clean
                      // photo bucket / batch view" (Sean). A real grid of
                      // real thumbnails, every one still openable at full
                      // size — "don't reduce the upload to filenames."
                      <div className="mt-1">
                        <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-6">
                          {imageUrls.map((url, idx) => (
                            <a
                              key={url}
                              href={url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="block aspect-square overflow-hidden rounded-md border"
                              style={{ borderColor: GENESIS_ATMOSPHERE.border }}
                              aria-label={`View photo ${idx + 1} of ${imageUrls.length} full size`}
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element -- same reasoning as the single-photo case below: Vercel Blob is an arbitrary per-deployment host next/image can't optimize without ongoing config */}
                              <img src={url} alt="" className="h-full w-full object-cover" />
                            </a>
                          ))}
                        </div>
                        <p className="mt-1.5 break-words text-xs" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
                          {m.content}
                        </p>
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
                          <img src={imageUrl} alt={m.content} className="block max-h-64 w-auto max-w-full object-cover sm:max-w-[260px]" />
                        </a>
                        <p className="mt-1 break-words text-xs" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
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
                      <div className="mt-1 min-w-0">
                        <audio src={audioUrl} controls preload="metadata" className="h-10 w-full max-w-full sm:max-w-xs" />
                        <p className="mt-1.5 text-sm leading-relaxed text-[#f4f2fb] break-words">{m.content}</p>
                      </div>
                    ) : (
                      <p data-role="content" className="mt-1 text-sm leading-relaxed text-[#f4f2fb] break-words">
                        {m.content}
                      </p>
                    )}
                    {quickReplies && quickReplies.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {quickReplies.map((option) => (
                          <button
                            key={option}
                            type="button"
                            onClick={() => sendQuickReply(option)}
                            className="rounded-full border px-3 py-1.5 text-xs font-medium text-[#f4f2fb] transition hover:bg-white/[.06]"
                            style={{ borderColor: GENESIS_ATMOSPHERE.violet }}
                          >
                            {option}
                          </button>
                        ))}
                      </div>
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
            <div className="flex w-full min-w-0 max-w-full flex-col divide-y" style={{ borderColor: GENESIS_ATMOSPHERE.border }}>
              {tasks.map((t) => (
                <CategoryRow key={t.id} title={t.title} summary={t.summary} href={t.href} dotClassName={taskPriorityDotClassName(t.priority)} />
              ))}
            </div>
          )
        ) : activeCategory === "ideas" ? (
          ideas.length === 0 ? (
            <CategoryEmptyState label="Ideas" />
          ) : (
            <div className="flex w-full min-w-0 max-w-full flex-col divide-y" style={{ borderColor: GENESIS_ATMOSPHERE.border }}>
              {ideas.map((o) => (
                <CategoryRow key={o.id} summary={o.summary} href={o.href} dotClassName="bg-purple-500" />
              ))}
            </div>
          )
        ) : activeCategory === "decisions" ? (
          decisions.length === 0 ? (
            <CategoryEmptyState label="Decisions" />
          ) : (
            <div className="flex w-full min-w-0 max-w-full flex-col divide-y" style={{ borderColor: GENESIS_ATMOSPHERE.border }}>
              {decisions.map((d) => (
                <CategoryRow key={d.id} summary={d.summary} href={d.href} dotClassName="bg-amber-400" />
              ))}
            </div>
          )
        ) : information.length === 0 ? (
          <CategoryEmptyState label="Information" />
        ) : (
          <div className="flex w-full min-w-0 max-w-full flex-col divide-y" style={{ borderColor: GENESIS_ATMOSPHERE.border }}>
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
        className="w-full min-w-0 max-w-full shrink-0 overflow-x-hidden border-t px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-2"
        style={{ borderColor: GENESIS_ATMOSPHERE.border }}
      >
        {/* Priority 4 — Just Talk, mic-primary layout (frozen scope, Sean's
            explicit call). VoiceMemoButton stays exactly ONE instance at
            the same position in this row, regardless of mode — only its
            own size prop and its neighbors change. Splitting this into two
            separately-rendered VoiceMemoButtons (one per mode) would
            unmount/remount it on every toggle, silently dropping the
            cached getUserMedia() stream (see streamRef's own comment) and,
            worse, truncating a real recording if toggled mid-recording. */}
        <div className={justTalk ? "mb-2 flex items-center justify-center" : "mb-1.5 flex items-center gap-1.5"}>
          {!justTalk && (
            <>
              <span className="pl-1 text-[10px] font-semibold uppercase tracking-wide" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
                Add to J4
              </span>
              <UploadAssetButton
                label="Add photos"
                icon="📷"
                accept="image/png,image/jpeg,image/webp,image/heic,image/heif"
                uploadAsset={uploadAsset}
                uploadAssetBatch={uploadPhotoBatch}
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
            </>
          )}
          <VoiceMemoButton
            uploadVoiceMemo={uploadVoiceMemo}
            currentPath={currentPath}
            onStart={handleVoiceMemoStart}
            onFailure={(message) => {
              clearVoiceMemoPlaceholder();
              setSendError(message);
            }}
            onTranscribed={sendVoiceMemo}
            size={justTalk ? "large" : "default"}
          />
        </div>
        <div
          className="flex min-w-0 w-full max-w-full items-end gap-2 rounded-2xl border-2 p-1.5 pl-4"
          style={{ borderColor: GENESIS_ATMOSPHERE.violet, backgroundColor: GENESIS_ATMOSPHERE.bgElevated }}
        >
          <textarea
            ref={messageInputRef}
            name="message"
            placeholder="Talk to J4 — ask, instruct, or tell J4 what you're working on…"
            rows={1}
            required
            onFocus={() => setGenesisComposing(true)}
            onBlur={() => setGenesisComposing(false)}
            className="min-w-0 max-h-40 min-h-[2.75rem] flex-1 resize-none bg-transparent py-2.5 text-[15px] text-[#f4f2fb] placeholder:text-[rgba(244,242,251,0.45)] focus:outline-none"
          />
          <SubmitButton
            // Real bug (Sean, 2026-08-08, from a real screenshot): "…" here
            // read as a second, competing "thinking" indicator sitting
            // inside the send button — the real one belongs only in the
            // response area (see isStreamingPlaceholder's own four-bar
            // indicator below). The button now stays visually identical
            // while pending — same arrow, just dimmed via the existing
            // disabled:opacity-50 — never a second signal of its own.
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
