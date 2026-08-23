"use client";

import { useCallback, useContext, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { unstable_rethrow, usePathname, useRouter } from "next/navigation";
import { useFormStatus, flushSync } from "react-dom";
import { upload as blobUpload } from "@vercel/blob/client";
import { deriveAssessmentState, GENESIS_STATE_META } from "@/lib/dashboard/genesisState";
import { GENESIS_ATMOSPHERE } from "@/lib/dashboard/genesisAtmosphere";
import { MESSAGE_STATE_LABEL, needsOwner, type MessageState } from "@/lib/j4/messageState";
import { setGenesisComposing, setGenesisWorking } from "@/lib/dashboard/genesisActivity";
import { USAGE_CEILING_MESSAGE } from "@/lib/dashboard/genesisModelMessages";
import { callGenesisAction } from "@/lib/dashboard/submitGenesisAction";
import { mapWithConcurrency, withRetry } from "@/lib/concurrency";
import { ALLOWED_CONTENT_TYPES, MAX_UPLOAD_BYTES, resolveAssetContentType } from "@/lib/businessAssets/uploadAssetFile";
import { SubmitButton } from "@/app/dashboard/SubmitButton";
import { GenesisAvatar } from "@/app/dashboard/GenesisAvatar";
import { GENESIS_AVATAR_SIZE } from "@/lib/dashboard/genesisAvatarSize";
import { extractAudioUrl, extractChangeList, extractImageUrl, extractImageUrls, extractQuickReplies } from "./messageChanges";
import { VoiceMemoButton } from "./VoiceMemoButton";
import { J4SpeakButton } from "./J4SpeakButton";
import { J4HandoffContext } from "@/app/dashboard/J4HandoffContext";

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
  /**
   * What the message turned out to be, from its execution row.
   *
   * Computed on the server (lib/j4/messageState.ts) so the client never has to
   * decide what a status means, and never sees the row itself. Optimistic
   * messages have none until the turn is real, which is correct: nothing has
   * happened yet to have a state.
   */
  state?: MessageState;
};

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
// Understanding joined them 2026-08-16. It is the same kind of thing as the
// other four — real material J4 holds about the business — and it was living
// as its own nav destination, which made the Office an incomplete picture of
// what J4 knows. It is a reference view rather than a queue, so it carries no
// count: there is nothing to clear.
type Category = "conversation" | "tasks" | "ideas" | "decisions" | "information" | "understanding";

// Where this conversation is being rendered. "layer" is the persistent J4
// over the business workspace (app/dashboard/J4Overlay.tsx); "room" is the
// full /j4 destination. See J4Workspace's own comment for what separates
// them and why it is one component rather than two.
export type J4Surface = "layer" | "room";

// Remembers that the owner entered the room from their own business, so the
// way back can be a real history step rather than a fresh navigation to
// /dashboard. That distinction is the whole of Sean's requirement: "if a
// user intentionally enters the full J4 room and later returns to the
// business, the original workspace and scroll position should be preserved."
// Going back restores both, because the App Router restores scroll on a
// history traversal; pushing /dashboard would land them at the top of a page
// they were not on. sessionStorage rather than a query param so a refresh
// inside the room keeps working and the URL stays clean.
const ROOM_ENTERED_FROM_KEY = "j4:enteredFrom";

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
// One heading's worth of what J4 understands, already shaped and formatted on
// the server (J4Surface). Deliberately plain strings: this crosses into a
// client component, so no Dates, no Prisma rows, and no nested model objects
// that would need re-deriving here. The Understanding page owns the full,
// linkable version; this is the same material read as a briefing.
export interface UnderstandingGroup {
  key: string;
  label: string;
  lines: string[];
  /** Shown in place of the lines when J4 genuinely knows nothing here yet. */
  empty: string;
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

// Real per-file lifecycle (2026-08-09) — "queued -> uploading -> uploaded
// / failed... make the progress indicator truthful" (Sean, from real
// mobile testing evidence: a real 10-image batch got visibly stuck at "1
// of 12," with individual PNGs failing on a generic connection/timeout
// message). Traced the actual pipeline rather than assuming: that exact
// per-file "(Genesis couldn't complete that...)" message can ONLY come
// from callGenesisAction's own generic catch-all (submitGenesisAction.ts),
// wrapping ONE PER FILE — which only happens in the old sequential loop
// below, never in the batch path. The sequential loop calls uploadAsset
// per file, and uploadBusinessAssetFromChat does a REAL, SYNCHRONOUS
// Claude classification call before it ever returns — several real
// seconds each, one at a time, zero concurrency, zero retry. The batch
// path (uploadAssetBatch/uploadPhotoBatchFromChat) is fundamentally
// different and faster: it only ingests (a cheap DB write) and defers
// classification, with real concurrency via mapWithConcurrency. The
// actual fix is structural, not a retry bolted onto the slow path: a
// multi-file image selection must never be able to reach the slow,
// unparallelized, retry-less sequential loop at all — every file that CAN
// go through uploadAssetBatch now does, regardless of count (the old
// `validFiles.length > 1` gate is gone). The sequential loop still exists
// only for callers with no batch handler at all (documents, today).
type FileUploadStatus = "queued" | "uploading" | "uploaded" | "failed";
interface BatchEntry {
  id: string;
  file: File;
  extension: string;
  // Real mobile-browser gotcha fix (2026-08-09) — resolved once at
  // selection time via resolveAssetContentType (browser-reported type,
  // falling back to the filename's own extension when that's empty/
  // unrecognized), then used everywhere downstream instead of re-reading
  // file.type directly, so a file the browser mis-reports still uploads
  // with the CORRECT content type rather than carrying the empty/wrong
  // one all the way to Blob storage and the server-side finalize check.
  contentType: string;
}
interface LiveFileState {
  id: string;
  name: string;
  status: FileUploadStatus;
}

let batchEntrySeq = 0;
function makeBatchEntry(file: File, extension: string, contentType: string): BatchEntry {
  batchEntrySeq += 1;
  return { id: `${file.name}-${file.size}-${file.lastModified}-${batchEntrySeq}`, file, extension, contentType };
}

function UploadAssetButton({
  label,
  icon,
  accept,
  uploadAsset,
  uploadAssetBatch,
  currentPath,
  surface,
  onFailure,
}: {
  label: string;
  icon: string;
  accept: string;
  uploadAsset: (formData: FormData) => void;
  // J4 Portal batch intake (2026-08-08) — optional, and only ever passed
  // for the photo button today ("documents eventually," Sean's own
  // words, not built yet). Whenever present, EVERY file (not just a
  // multi-file selection — see this block's own top comment) goes through
  // the resilient batch path: uploaded to Blob with real concurrency +
  // automatic retry, then handed to uploadAssetBatch in one call. Only a
  // caller with no batch handler at all falls back to the slower
  // sequential loop.
  uploadAssetBatch?: (formData: FormData) => void;
  currentPath: string;
  // Travels with currentPath everywhere a chat turn is submitted: together
  // they are "where the owner is" and "whether finishing there is allowed to
  // move them." See ai-actions.ts's redirectKeepingChatOpen.
  surface: J4Surface;
  onFailure: (message: string) => void;
}) {
  const [isPending, startTransition] = useTransition();
  const [progress, setProgress] = useState<{ succeeded: number; total: number } | null>(null);
  // Live per-file status, shown while a run is in flight — "the progress
  // indicator should visibly advance as each file completes," not just a
  // number. Cleared (not just left stale) at the very start of every new
  // selection — see the real bug fixed below this state block.
  const [liveFiles, setLiveFiles] = useState<LiveFileState[] | null>(null);
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
  const [failedBatchFiles, setFailedBatchFiles] = useState<BatchEntry[] | null>(null);
  const [readyBatchFiles, setReadyBatchFiles] = useState<{ blobUrl: string; originalFilename: string; contentType: string }[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  function setEntryStatus(id: string, status: FileUploadStatus) {
    setLiveFiles((prev) => (prev ? prev.map((f) => (f.id === id ? { ...f, status } : f)) : prev));
  }

  // Automatic retry for transient failures (2026-08-09) — confirmed
  // against Vercel's own current docs before writing this: @vercel/blob's
  // client upload() has no built-in whole-request retry of its own (only
  // multipart's internal part-retry, for one large file split into
  // chunks — not this). By the time a file reaches this call it has
  // already passed local content-type/size validation, so any failure
  // here really is transient (dropped connection, timeout, a momentary
  // 5xx) — safe to retry automatically without inspecting the error.
  async function uploadOneToBlob(entry: BatchEntry) {
    setEntryStatus(entry.id, "uploading");
    return withRetry(
      async () => {
        const blob = await blobUpload(`assets/${randomAssetKey()}.${entry.extension}`, entry.file, {
          access: "public",
          handleUploadUrl: "/api/blob/business-asset-upload",
          contentType: entry.contentType,
        });
        return { blobUrl: blob.url, originalFilename: entry.file.name, contentType: entry.contentType };
      },
      { attempts: 3, baseDelayMs: 1000 }
    );
  }

  // A real concurrency cap, not "all N at once" — each Blob upload also
  // invokes a serverless function to authenticate it (see
  // app/api/blob/business-asset-upload/route.ts), so throttling this is
  // what actually keeps a 100+ file selection from overwhelming both the
  // phone's own network stack and that function's concurrent invocations.
  const BATCH_UPLOAD_CONCURRENCY = 4;

  async function runBatchUpload(entries: BatchEntry[]) {
    setProgress({ succeeded: 0, total: entries.length });
    let succeededSoFar = 0;
    const newlySucceeded: { blobUrl: string; originalFilename: string; contentType: string }[] = [];
    const stillFailing: BatchEntry[] = [];

    await mapWithConcurrency(entries, BATCH_UPLOAD_CONCURRENCY, uploadOneToBlob, (index, result) => {
      const entry = entries[index];
      if (result.ok) {
        succeededSoFar += 1;
        newlySucceeded.push(result.value);
        setEntryStatus(entry.id, "uploaded");
      } else {
        stillFailing.push(entry);
        setEntryStatus(entry.id, "failed");
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
      formData.set("surface", surface);
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

          // Real bug fix (2026-08-09) — a prior run's failed/ready state
          // was never cleared when a new selection began. A second pick
          // made while an earlier batch's review panel was still showing
          // could silently combine two independent batches into one
          // count — exactly the kind of "queue" bug behind a mismatched
          // total. A new selection is always a new, independent batch.
          setFailedBatchFiles(null);
          setReadyBatchFiles([]);
          setLiveFiles(null);
          setProgress(null);

          const validFiles: BatchEntry[] = [];
          const problems: string[] = [];
          for (const file of files) {
            const contentType = resolveAssetContentType(file);
            const extension = contentType ? ALLOWED_CONTENT_TYPES[contentType] : undefined;
            if (!contentType || !extension) {
              problems.push(`${file.name} (unsupported type)`);
              continue;
            }
            if (file.size > MAX_UPLOAD_BYTES) {
              problems.push(`${file.name} (over 20MB)`);
              continue;
            }
            validFiles.push(makeBatchEntry(file, extension, contentType));
          }
          if (validFiles.length === 0) {
            onFailure(
              problems.length > 0
                ? `Couldn't upload: ${problems.join(", ")}. Genesis currently accepts PNG, JPEG, WebP, HEIC, DOCX, or PDF files.`
                : "Please choose a PNG, JPEG, WebP, HEIC, DOCX, or PDF file."
            );
            return;
          }

          startTransition(async () => {
            // Resilient batch upload (2026-08-08, hardened 2026-08-09) —
            // every file goes through one throttled, auto-retrying,
            // fault-tolerant pool, never the slow one-at-a-time loop, as
            // long as this button has a batch handler at all. See this
            // function's own top comment for why the old file-count gate
            // was removed.
            if (uploadAssetBatch) {
              setLiveFiles(validFiles.map((e) => ({ id: e.id, name: e.file.name, status: "queued" })));
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

            // No batch handler for this button (documents, today) — same
            // real per-file resilience (retry, isolated failures, live
            // status), just submitted one at a time since there's no
            // batch-intake Server Action to hand them to yet.
            setLiveFiles(validFiles.map((e) => ({ id: e.id, name: e.file.name, status: "queued" })));
            for (let i = 0; i < validFiles.length; i++) {
              const entry = validFiles[i];
              const isLast = i === validFiles.length - 1;
              setProgress({ succeeded: i, total: validFiles.length });
              setEntryStatus(entry.id, "uploading");
              const result = await callGenesisAction(async () => {
                const blob = await withRetry(
                  () =>
                    blobUpload(`assets/${randomAssetKey()}.${entry.extension}`, entry.file, {
                      access: "public",
                      handleUploadUrl: "/api/blob/business-asset-upload",
                      contentType: entry.contentType,
                    }),
                  { attempts: 3, baseDelayMs: 1000 }
                );
                const formData = new FormData();
                formData.set("blobUrl", blob.url);
                formData.set("originalFilename", entry.file.name);
                formData.set("contentType", entry.contentType);
                formData.set("currentPath", currentPath);
                formData.set("surface", surface);
                // Only the batch's last file redirects/reopens the
                // conversation — see uploadBusinessAssetFromChat's own
                // comment on why every earlier one must not (Next only
                // ever lets one redirect actually navigate per submit).
                if (!isLast) formData.set("skipRedirect", "true");
                return uploadAsset(formData);
              });
              if (!result.ok) {
                // Resilient sequential upload (2026-08-08) — a real
                // failure on one document used to abort every file after
                // it, even ones that would have succeeded. Recorded and
                // skipped instead; the rest of the selection still gets a
                // real attempt.
                setEntryStatus(entry.id, "failed");
                problems.push(`${entry.file.name} (${result.message})`);
                continue;
              }
              setEntryStatus(entry.id, "uploaded");
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

      {/* Live per-file status — "queued -> uploading -> uploaded/failed,"
          visibly advancing as each file completes, not a static count.
          Absolutely positioned, matching VoiceMemoButton's own recovery-
          panel pattern — never affects the composer row's own layout. */}
      {isPending && liveFiles && liveFiles.length > 1 && (
        <div
          className="absolute bottom-full left-0 z-10 mb-2 w-72 rounded-xl border p-3 text-xs shadow-lg"
          style={{ borderColor: GENESIS_ATMOSPHERE.border, backgroundColor: GENESIS_ATMOSPHERE.bgElevated }}
        >
          <p className="font-medium text-[#f4f2fb]">
            Uploading {progress?.succeeded ?? 0}/{progress?.total ?? liveFiles.length}
          </p>
          <ul className="mt-1.5 max-h-32 overflow-y-auto">
            {liveFiles.map((f) => (
              <li key={f.id} className="flex items-center gap-1.5 truncate py-0.5 text-[rgba(244,242,251,0.75)]">
                <span aria-hidden="true" className="shrink-0">
                  {f.status === "uploaded" ? "✓" : f.status === "failed" ? "✕" : f.status === "uploading" ? "…" : "·"}
                </span>
                <span className="truncate">{f.name}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

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
              <li key={f.id} className="truncate">{f.file.name}</li>
            ))}
          </ul>
          <div className="mt-2.5 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={isPending}
              onClick={() => {
                startTransition(async () => {
                  setLiveFiles(failedBatchFiles.map((e) => ({ id: e.id, name: e.file.name, status: "queued" })));
                  const { newlySucceeded, stillFailing } = await runBatchUpload(failedBatchFiles);
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
  surface,
  onFailure,
}: {
  sendMessage: (formData: FormData) => void;
  previousUserMessage: string;
  currentPath: string;
  surface: J4Surface;
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
        formData.set("surface", surface);
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
  slug,
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
  understanding,
  surface,
  proposal,
}: {
  /**
   * The business this workspace is for, when it was named in the URL.
   *
   * Sent with every chat POST so the turn is written against the business on
   * screen rather than the account's active one — the surface was fixed for
   * that in August, the path that WRITES was not.
   */
  slug?: string;
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
  understanding: UnderstandingGroup[];
  surface: J4Surface;
  // J4's current proposal, server-rendered and handed down. Sits directly
  // above the composer, because the composer is how the owner argues with it
  // — see J4Proposal.tsx for why there is no "refine" button.
  proposal?: React.ReactNode;
} & J4Signals) {
  // Two surfaces, one conversation (2026-08-14). Sean's clarification:
  // "the persistent J4 summon is not a shortcut to the J4 page. It is the
  // primary way users converse with J4 while working inside their business."
  //
  // So the layer is the conversation and nothing else. Tasks, Ideas,
  // Decisions and Information are real, and they are exactly what the room
  // is for — reading the record, reviewing what is queued, doing deliberate
  // deep work. Putting them in the layer would rebuild the destination the
  // layer exists to make unnecessary, and would answer "I have a quick
  // question" with a management console.
  //
  // Neither surface owns the conversation. Both read the same StoreMessage
  // rows and write through the same actions, so asking in the layer and then
  // opening the room shows the same exchange, and this stayed a prop rather
  // than a second component precisely so the two can never drift.
  const isLayer = surface === "layer";
  // Where the owner actually is (2026-08-14), not where J4 lives. This was
  // hardcoded to "/j4" back when J4 was a route, and the hardcoding survived
  // the move to a persistent layer as a real bug: this same conversation now
  // usually renders over /dashboard/website or /dashboard/products, and the
  // heavy fallback path would have redirected the owner to a bare /j4 page
  // they never asked to be on. It also becomes the one thing that lets J4
  // resolve "this" — see lib/j4/workspaceContext.ts.
  const currentPath = usePathname();
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
  // The "+" tray (2026-08-16). Sean: the camera, document and voice controls
  // sitting out beside the composer read as clutter, so they fold behind one
  // control and the default composer is `+ → Talk to J4… → Send`.
  //
  // This is open/closed state, NOT mount/unmount state, and the difference is
  // load-bearing: VoiceMemoButton caches a getUserMedia() stream and must stay
  // exactly one instance at one position (see its own comment below). Rendering
  // the tray conditionally would drop that stream on every toggle and truncate
  // a recording in progress. The row is therefore always mounted and merely
  // hidden, which is the same reason J4Overlay stays mounted while closed.
  const [addOpen, setAddOpen] = useState(false);
  // Just Talk stays room-only: it means "step away from the rail", and it is
  // derived rather than guarded at each use so there is exactly one place it
  // can be true.
  const talkingOnly = justTalk && !isLayer;
  // THE LAYER SWITCHES CATEGORIES NOW (2026-08-15). This read
  // `isLayer ? "conversation" : activeCategory`, which was correct while the
  // layer had no rail — and became a bug the moment the rail was shown there,
  // because the tabs rendered, highlighted on tap, and changed nothing. The
  // Office is the layer, so the layer honours the selection like the room
  // always did. Just Talk still pins the view, which is what it is for.
  const shownCategory: Category = talkingOnly ? "conversation" : activeCategory;
  const overallState = deriveAssessmentState({ hasUrgentIssue, hasPendingDecision, hasOpportunity, hasCuriosity });

  // Leaving the room. Back when the owner came from their own business (the
  // layer pushed us here), so the workspace and its scroll position come
  // back exactly as they were; a plain navigation only for someone who
  // arrived at /j4 cold, from a link or a bookmark, and has nothing to
  // return to.
  const leaveRoom = useCallback(() => {
    const enteredFrom = typeof window === "undefined" ? null : window.sessionStorage.getItem(ROOM_ENTERED_FROM_KEY);
    if (enteredFrom) {
      window.sessionStorage.removeItem(ROOM_ENTERED_FROM_KEY);
      router.back();
      return;
    }
    router.push("/dashboard");
  }, [router]);

  // `enterRoom` was here: it recorded where the owner was and pushed /j4, so
  // the layer could offer a second, deeper Office. Deleted with the button
  // that called it (2026-08-15) rather than left dead, because a ready-made
  // "go one level deeper" helper sitting unused is an invitation to rebuild
  // the nesting it created. The Office is the layer; nothing navigates into
  // a further one.

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

  // Text typed into J4's persistent presence, taken exactly once (2026-08-14).
  //
  // The presence has a field so the owner can type without opening anything,
  // but it never sends. It hands the text here, and this submits it through
  // the one real form — the same path a message typed in this composer takes,
  // so streaming, the slower fallback, failure recovery and everything else
  // behave identically no matter where the owner started typing.
  //
  // requestSubmit rather than calling handleSend directly, matching how quick
  // replies already dispatch: one real form, one real action, never a second
  // parallel call path. Cleared immediately so a remount or re-render can
  // never resend it.
  const j4Handoff = useContext(J4HandoffContext);
  const handoffText = j4Handoff.text;
  const handoffFocus = j4Handoff.focusComposer;
  const handoffAudioUrl = j4Handoff.audioUrl ?? null;
  useEffect(() => {
    if (!handoffText && !handoffFocus) return;
    const field = messageInputRef.current;
    const form = formRef.current;
    j4Handoff.clear();
    if (!field) return;

    if (handoffText && form) {
      // A memo recorded at the presence goes through sendVoiceMemo, the exact
      // function the microphone inside this conversation already uses, so the
      // persisted message renders as playable audio rather than bare text and
      // there is still only one way a memo is sent.
      if (handoffAudioUrl) {
        sendVoiceMemo(handoffText, handoffAudioUrl);
        return;
      }
      field.value = handoffText;
      form.requestSubmit();
      return;
    }

    // Expanded by typing rather than by sending: the owner is mid-thought in
    // a field that just got covered by this one, so the cursor follows them.
    // Kept in the same task as the original focus event so a phone keeps the
    // keyboard up rather than closing and reopening it.
    field.focus();
    // sendVoiceMemo is deliberately not a dependency. It is a hoisted
    // declaration recreated each render, so listing it would re-run this
    // effect on every render, and a stale closure cannot bite here: it only
    // touches refs, which are always current, and this effect clears the
    // handoff synchronously before calling anything.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handoffText, handoffFocus, handoffAudioUrl, j4Handoff]);

  // Talk Mode's return leg (2026-08-14, corrected).
  //
  // This first hooked the streaming "done" event, which was wrong in a way
  // that only showed up on a real device: a turn needing the heavier content
  // pipeline falls back to the Server Action and never emits "done", so Talk
  // Mode waited for a reply that was never announced and sat on "Thinking"
  // forever. Watching the CONVERSATION instead covers both paths, because
  // every reply lands in these messages however it was produced.
  //
  // The id of the last spoken reply is remembered so a re-render, a
  // revalidation or a reconnect can never speak the same answer twice.
  const spokenReplyIdRef = useRef<string | null>(null);
  const lastEntry = localMessages[localMessages.length - 1];
  const onAssistantReply = j4Handoff.onAssistantReply;
  useEffect(() => {
    if (!onAssistantReply) return;
    if (!lastEntry || lastEntry.role !== "assistant") return;
    // An optimistic placeholder is empty until content streams in; speaking it
    // would say nothing and end the turn early.
    if (!lastEntry.content.trim()) return;
    if (spokenReplyIdRef.current === lastEntry.id) return;
    spokenReplyIdRef.current = lastEntry.id;
    onAssistantReply(lastEntry.content);
  }, [lastEntry, onAssistantReply]);

  // Defense-in-depth for the same "typed text disappears while attachments
  // upload" bug the narrowed visibilitychange refresh above targets — this
  // guards the composer regardless of what actually causes a stray
  // remount/reset (there could be more than one path into it, on top of
  // the real one found above). sessionStorage, not React state: the
  // textarea itself stays deliberately uncontrolled (existing convention,
  // read via FormData on submit), so this restores on mount rather than
  // trying to make every keystroke round-trip through React.
  const DRAFT_STORAGE_KEY = "j4-portal-draft-message";
  useEffect(() => {
    if (typeof window === "undefined" || !messageInputRef.current) return;
    const saved = window.sessionStorage.getItem(DRAFT_STORAGE_KEY);
    if (saved && !messageInputRef.current.value) {
      messageInputRef.current.value = saved;
    }
  }, []);
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
  // Real bug fix (2026-08-09) — this fired router.refresh() on EVERY
  // visibilitychange "visible" event, with no minimum-hidden-duration
  // check. A native mobile photo/document picker backgrounds the tab for
  // a couple of seconds too — the single most common moment for this to
  // fire is exactly mid-upload, refetching page.tsx's server data
  // (messages, tasks, etc.) and feeding a fresh `messages` array into the
  // "adjust state during render" resync above (`if (messages !==
  // syncedMessages) { ...; setLocalMessages(messages); }`), which is a
  // real, plausible mechanism for wiping in-progress composer state right
  // when the owner returns from picking attachments — the exact bug Sean
  // reported ("typed text disappears while photos are being added").
  // Narrowed to only refresh after a REAL absence (>=15s hidden), which
  // still covers the original "left /j4 to approve something elsewhere,
  // came back later" case this was built for, without firing on a quick
  // picker round trip. pageshow's real bfcache-restoration signal
  // (event.persisted) is untouched — that's a a different, always-genuine
  // "you navigated away and the browser restored a stale page" case.
  const hiddenSinceRef = useRef<number | null>(null);
  useEffect(() => {
    function refreshOnReturn() {
      router.refresh();
    }
    function handlePageShow(event: PageTransitionEvent) {
      if (event.persisted) refreshOnReturn();
    }
    function handleVisibilityChange() {
      if (document.visibilityState === "hidden") {
        hiddenSinceRef.current = Date.now();
        return;
      }
      const hiddenSince = hiddenSinceRef.current;
      hiddenSinceRef.current = null;
      if (hiddenSince !== null && Date.now() - hiddenSince >= 15_000) {
        refreshOnReturn();
      }
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
    if (!result.ok) {
      // A genuine, non-redirecting failure — the only case that should roll
      // back the optimistic entries (see handleSend's own comment on why the
      // fallback path itself no longer does).
      setStreamingStatus(null);
      setSendError(result.message);
      rollBackOptimisticEntries();
      return;
    }
    // Success without a redirect, which only the layer produces (2026-08-14).
    // For the room this line is still unreachable, exactly as the comment
    // that used to sit here said: sendStoreMessage ends in redirect(), thrown
    // as Next's own NEXT_REDIRECT and re-thrown past this by
    // callGenesisAction's unstable_rethrow, and the page re-render is what
    // cleared the status.
    //
    // The layer has no re-render to hide behind. It finishes in place, so the
    // status has to be taken down here or the owner is left reading "J4 is
    // working on a complete response" over a reply that already arrived. The
    // optimistic entries are deliberately left alone: the revalidation this
    // turn triggered delivers the real messages, and the resync above swaps
    // them in without a flicker.
    setStreamingStatus(null);
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
    if (typeof window !== "undefined") window.sessionStorage.removeItem(DRAFT_STORAGE_KEY);
    // Empty the composer here, in the one place every send passes through
    // (2026-08-18). The draft was already being cleared from sessionStorage but
    // the field itself was not, so a recommendation tapped in Studio arrived in
    // the Office, sent correctly, and then SAT IN THE INPUT as though the owner
    // had typed it and not pressed send. FormData is captured synchronously by
    // the submit that got us here, so clearing now cannot lose the message.
    if (messageInputRef.current) messageInputRef.current.value = "";
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
        // workspacePath is what the owner is looking at while asking. The
        // server matches it against a closed registry and ignores anything
        // it does not recognise, so this is a hint, never a channel.
        body: JSON.stringify({ message: text, requestId, audioUrl: audioUrl ?? undefined, workspacePath: currentPath, slug }),
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
            | { type: "navigate"; href: string }
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
          } else if (event.type === "navigate") {
            // J4 takes the owner there rather than telling them where it is.
            // Pushed rather than replaced, so the back gesture still returns
            // them to where they were — being moved somewhere is not the same
            // as losing where you came from.
            reportDiag(requestId, tStart, "client_navigate_event_received", { href: event.href });
            router.push(event.href);
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
  // Two callers now: the mic in this composer, and a memo recorded at J4's
  // persistent presence and handed down. One way a memo is sent, reached from
  // two places.
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
    el.scrollTop = shownCategory === "conversation" ? el.scrollHeight : 0;
  }, [localMessages.length, lastMessageContentLength, shownCategory]);

  const categoryTabs: { key: Category; label: string; count: number }[] = [
    { key: "conversation", label: "Conversation", count: 0 },
    { key: "tasks", label: "Tasks", count: tasks.length },
    { key: "ideas", label: "Ideas", count: ideas.length },
    { key: "decisions", label: "Decisions", count: decisions.length },
    { key: "information", label: "Information", count: information.length },
    // No count, deliberately. The four above are queues an owner works down;
    // Understanding is a standing picture of what J4 knows, and a number
    // beside it would read as "14 things to deal with."
    { key: "understanding", label: "Understanding", count: 0 },
  ];

  return (
    <form
      ref={formRef}
      action={handleSend}
      // The room owns the screen. The layer fills whatever the overlay gives
      // it and nothing more — a fixed element here would break out of the
      // sheet and cover the workspace it is supposed to sit over.
      className={`flex w-full flex-col overflow-x-hidden text-[#f4f2fb] ${
        isLayer ? "h-full" : "fixed inset-0 z-[100]"
      }`}
      style={{ backgroundColor: GENESIS_ATMOSPHERE.bg }}
    >
      {/* The business this composer belongs to, travelling with every action it
          submits (2026-08-21). Server actions here take FormData, so this is
          how the slug reaches them without changing a signature apiece —
          upload, voice memo and the non-streaming send all read it. Absent on
          the legacy /dashboard route, where the active business is still the
          right answer. */}
      {slug ? <input type="hidden" name="slug" value={slug} /> : null}
      <input type="hidden" name="currentPath" value={currentPath} />
      {/* Tells the server whether finishing this turn is allowed to move the
          owner. The layer's answer is no, always. */}
      <input type="hidden" name="surface" value={surface} />
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
            {overallState !== "idle" && !talkingOnly && (
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
          {talkingOnly && decisions.length > 0 && (
            <span
              className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium"
              style={{ backgroundColor: "rgba(251,191,36,0.12)", color: "#fbbf24" }}
              title="Waiting for your decision — see the Decisions tab in Workspace"
            >
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" aria-hidden="true" />
              {decisions.length} waiting for you
            </span>
          )}
          {!isLayer && (
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
          )}
          {isLayer ? (
            // NOTHING. There used to be an "Office" button here, and removing
            // it is the fix for what Sean found in testing (2026-08-15):
            // "multiple nested J4/Office windows that are effectively
            // representing the same thing... Room → J4 pull-up → Office →
            // another Office/workspace layer."
            //
            // That is exactly what this button did. The control beneath the
            // orb opens the Office; this then offered to open the Office
            // again, one surface deeper, because the deeper one was the only
            // place the categories lived. Two doors with the same name, one
            // inside the other.
            //
            // The layer is the Office. There is no second one to go to, so
            // there is no door here, and the way out is the overlay's own
            // close control — which returns the owner to exactly the room
            // they were standing in. Do not put a door back here.
            null
          ) : (
            <button
              type="button"
              onClick={leaveRoom}
              aria-label="Back to your business"
              className="-m-2 shrink-0 p-2 text-[rgba(244,242,251,0.62)] hover:text-[#f4f2fb]"
            >
              ✕
            </button>
          )}
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
          rail is hidden but a non-Conversation tab is showing.
          THE LAYER SHOWS IT NOW (2026-08-15). It used to be hidden here, on
          the reasoning that "those four categories are what the room is for,
          and rebuilding them over the workspace would answer a quick question
          with a console." That reasoning was sound while the layer was a 68%
          sheet you summoned over your work — but it is the thing that produced
          the nesting Sean hit in testing: the categories lived only in a
          second, deeper surface, so the layer had to grow a door to reach
          them, and the owner ended up two Offices deep.
          The layer IS the Office now — full screen, entered on purpose. So the
          categories are views inside it, which is what the architecture always
          said they were: "views/filters within the Office, not additional
          navigation layers." Answering a quick question is Talk Mode's job,
          and Talk Mode never opens this panel at all. */}
      {!talkingOnly && (
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
        {/* The proposal, inline at the end of the conversation (2026-08-14).
            It lived between the message list and the composer for one build,
            in a shrink-0 box outside every scroll container — so a tall
            comparison pushed "Apply this" and "Not this" past the bottom of
            the sheet with no way to reach them. A decision the owner cannot
            reach is not a decision.
            Here it scrolls with everything else, and it is also simply where
            it belongs: Sean's own shape is "conversation message -> proposal
            appears -> owner inspects -> owner responds", which is one thread,
            not a panel bolted underneath one. Rendered after the whole
            conversation branch rather than inside the has-messages case, so a
            proposal raised without any chat turn still appears. */}
        {shownCategory === "conversation" ? (
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
                // Null for an ordinary reply and for anything with no execution
                // row — which is most of the history, and must not read as a
                // completed change. See messageStateOf.
                const stateLabel = m.state ? MESSAGE_STATE_LABEL[m.state] : null;
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
                    {/* J4 Voice Output (2026-08-08) — only ever offered for
                        a real, finished assistant reply: never the
                        streaming placeholder (nothing to speak yet), never
                        the owner's own messages. */}
                    {m.role === "assistant" && !isStreamingPlaceholder && m.content && (
                      <J4SpeakButton text={m.content} />
                    )}
                    {/* WHAT ACTUALLY HAPPENED, next to what was said about it
                        (UI6). Read from the execution row on the server, never
                        from these words: a reply saying "done" over a row
                        saying WARNING is exactly the disagreement this exists
                        to surface, and the row wins.

                        An ordinary reply carries no badge — labelling every
                        sentence would make the ones that matter invisible. */}
                    {m.role === "assistant" && stateLabel && (
                      <span
                        data-role="message-state"
                        data-state={m.state}
                        className="mt-2 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium"
                        style={
                          needsOwner(m.state as MessageState)
                            ? { borderColor: GENESIS_ATMOSPHERE.violet, color: "#f4f2fb" }
                            : { borderColor: GENESIS_ATMOSPHERE.border, color: GENESIS_ATMOSPHERE.textSecondary }
                        }
                      >
                        <span
                          aria-hidden
                          className="h-1.5 w-1.5 rounded-full"
                          style={{
                            backgroundColor: needsOwner(m.state as MessageState)
                              ? GENESIS_ATMOSPHERE.violet
                              : GENESIS_ATMOSPHERE.textSecondary,
                          }}
                        />
                        {stateLabel}
                      </span>
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
                    {/* WHAT ACTUALLY CHANGED, AS THE PRIMARY STRUCTURE (UI6
                        piece 3, 2026-08-23).

                        This was a collapsed <details> labelled "See what
                        changed", sitting under several paragraphs of model
                        prose — so the trustworthy half of the reply was
                        subordinate to the half that can be wrong.

                        It is the trustworthy half BY CONSTRUCTION. This list is
                        built server-side in ai-actions.ts specifically to
                        CORRECT the model's reply, whose own comment records it
                        saying "Done" when execute() had actually failed. J4
                        writes the sentence above; it never writes this. Where
                        they disagree, this is right.

                        So it is open, it is not labelled as an aside, and it
                        reads as a list of real changes rather than something to
                        expand if curious. */}
                    {changeList && changeList.length > 0 && (
                      <ul
                        data-role="change-list"
                        className="mt-2 space-y-1 text-sm"
                        style={{ color: "#f4f2fb" }}
                      >
                        {changeList.map((c, i) => (
                          <li key={i} className="flex gap-2">
                            <span aria-hidden style={{ color: GENESIS_ATMOSPHERE.violet }}>
                              •
                            </span>
                            <span>{c}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          )
        ) : shownCategory === "tasks" ? (
          tasks.length === 0 ? (
            <CategoryEmptyState label="Tasks" />
          ) : (
            <div className="flex w-full min-w-0 max-w-full flex-col divide-y" style={{ borderColor: GENESIS_ATMOSPHERE.border }}>
              {tasks.map((t) => (
                <CategoryRow key={t.id} title={t.title} summary={t.summary} href={t.href} dotClassName={taskPriorityDotClassName(t.priority)} />
              ))}
            </div>
          )
        ) : shownCategory === "ideas" ? (
          ideas.length === 0 ? (
            <CategoryEmptyState label="Ideas" />
          ) : (
            <div className="flex w-full min-w-0 max-w-full flex-col divide-y" style={{ borderColor: GENESIS_ATMOSPHERE.border }}>
              {ideas.map((o) => (
                <CategoryRow key={o.id} summary={o.summary} href={o.href} dotClassName="bg-purple-500" />
              ))}
            </div>
          )
        ) : shownCategory === "decisions" ? (
          decisions.length === 0 ? (
            <CategoryEmptyState label="Decisions" />
          ) : (
            <div className="flex w-full min-w-0 max-w-full flex-col divide-y" style={{ borderColor: GENESIS_ATMOSPHERE.border }}>
              {decisions.map((d) => (
                <CategoryRow key={d.id} summary={d.summary} href={d.href} dotClassName="bg-amber-400" />
              ))}
            </div>
          )
        ) : shownCategory === "information" ? (
          // Made an explicit branch (2026-08-16). Information used to be the
          // final `else`, which quietly meant "any category that isn't one of
          // the four above" — so adding Understanding to the union would have
          // rendered Information under it, with no type error to say so. Each
          // category now names itself.
          information.length === 0 ? (
            <CategoryEmptyState label="Information" />
          ) : (
            <div className="flex w-full min-w-0 max-w-full flex-col divide-y" style={{ borderColor: GENESIS_ATMOSPHERE.border }}>
              {information.map((i) => (
                <CategoryRow key={i.id} summary={i.summary} href={i.href} dotClassName={i.kind === "urgent" ? "bg-red-500" : "bg-teal-400"} />
              ))}
            </div>
          )
        ) : (
          // Understanding. Grouped rather than listed, because it is the one
          // category that is not a queue of comparable items — "revenue" and
          // "who works here" are different kinds of fact and reading them as
          // one flat list would flatten that.
          //
          // Every group renders, including the ones J4 knows nothing about
          // yet, and each says so in its own words. That is the point rather
          // than an oversight: "I don't know your suppliers yet" is real
          // information about what J4 understands, and hiding empty groups
          // would quietly overstate how much it knows.
          understanding.length === 0 ? (
            // No groups at all means the caller could not read them — a role
            // without store:manage, matching what the Understanding page has
            // always required. Not the same as J4 knowing nothing, which is
            // what the per-group empty lines say.
            <CategoryEmptyState label="Understanding" />
          ) : (
          <div className="flex w-full min-w-0 max-w-full flex-col gap-5">
            {understanding.map((group) => (
              <div key={group.key} className="min-w-0">
                <p
                  className="text-[11px] font-semibold uppercase tracking-wide"
                  style={{ color: GENESIS_ATMOSPHERE.textSecondary }}
                >
                  {group.label}
                </p>
                {group.lines.length === 0 ? (
                  <p className="mt-1 text-sm" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
                    {group.empty}
                  </p>
                ) : (
                  <div className="mt-1 flex flex-col gap-1">
                    {group.lines.map((line, i) => (
                      <p key={i} className="min-w-0 break-words text-sm text-[#f4f2fb]">
                        {line}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
          )
        )}
        {shownCategory === "conversation" && proposal}
      </div>

      {showConfirmCeiling && previousUserMessage && (
        <div className="shrink-0 border-t px-5 pt-3" style={{ borderColor: GENESIS_ATMOSPHERE.border }}>
          <ConfirmCeilingOverride
            sendMessage={sendMessage}
            previousUserMessage={previousUserMessage}
            currentPath={currentPath}
            surface={surface}
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
        {/* Hidden, never unmounted, when the tray is closed — see addOpen's
            own comment. Just Talk keeps its mic-primary row on screen
            unconditionally: that mode exists to put the microphone front and
            centre, so folding it behind a "+" would defeat it. */}
        <div
          className={
            talkingOnly
              ? "mb-2 flex items-center justify-center"
              : addOpen
                ? "mb-1.5 flex items-center gap-1.5"
                : "hidden"
          }
        >
          {!talkingOnly && (
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
                surface={surface}
                onFailure={setSendError}
              />
              <UploadAssetButton
                label="Add documents"
                icon="📄"
                accept="application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                uploadAsset={uploadAsset}
                currentPath={currentPath}
                surface={surface}
                onFailure={setSendError}
              />
            </>
          )}
          <VoiceMemoButton
            uploadVoiceMemo={uploadVoiceMemo}
            currentPath={currentPath}
            surface={surface}
            onStart={handleVoiceMemoStart}
            onFailure={(message) => {
              clearVoiceMemoPlaceholder();
              setSendError(message);
            }}
            onTranscribed={sendVoiceMemo}
            size={talkingOnly ? "large" : "default"}
          />
        </div>
        <div className="flex min-w-0 w-full max-w-full items-end gap-2">
          {/* J4 Room doorway (2026-08-08, Phase 1) — "the small square
              control at the bottom-left" (Sean's own words) is navigation
              into the separate, immersive J4 Room screen, never a
              recording control — the small J4 avatar itself (always blue,
              never recolored) is what marks it as J4's own doorway rather
              than a generic icon. Composer shifts right and grows to two
              lines to make room for it, per the frozen design. Just Talk
              (justTalk state, header toggle, mic-primary row above) stays
              completely untouched — both entry points coexist until Room
              fully replaces Just Talk in a later cleanup pass.
              Room only. The immersive Room is deep work by definition, and a
              door out of the business does not belong in the layer whose
              entire point is that the owner never has to leave it to talk.
              It stays reachable exactly where deliberate destinations
              belong: one step in, through the room. */}
          {/* J4, present beside the composer (2026-08-16). Sean: "the J4
              orb/avatar should remain visible as the conversational presence
              next to the input... The user should feel like J4 is sitting
              there with them, not like they are operating a software form."
              The + consolidation was right and made the row quieter, but it
              also left the Office reading as `[+] Talk to J4 →`, which is a
              form. This is what makes it a conversation:

                  J4 = the partner I am talking to
                  +  = things I can give J4
                  →  = send what I said

              OUTSIDE the composer's border, deliberately. A 60px avatar was
              tried INSIDE it once and "made J4 read as part of the input
              rather than as a presence" (see genesisAvatarSize.ts) — the
              border is the line between J4 and the thing the owner types
              into, and putting him inside it dissolves exactly the
              distinction this is here to draw.

              PRESENCE, NOT A CONTROL. It does not navigate, open, or record.
              Talking to J4 by voice is the orb in the tab bar (Talk Mode) and
              a voice message is under +; a third way to start talking, in a
              third place, is the fragmentation this architecture keeps
              removing. Marked decorative so a screen reader is not told about
              a button that does not exist. */}
          {isLayer && (
            <div className="flex h-[4.5rem] shrink-0 items-center" aria-hidden="true">
              <GenesisAvatar className={GENESIS_AVATAR_SIZE.card} />
            </div>
          )}
          {!isLayer && (
            <Link
              href="/j4/room"
              aria-label="Enter J4 Room"
              title="Enter J4 Room"
              className="flex h-[4.5rem] w-[4.5rem] shrink-0 items-center justify-center rounded-2xl border-2 transition hover:opacity-90"
              style={{ borderColor: GENESIS_ATMOSPHERE.violet, backgroundColor: GENESIS_ATMOSPHERE.bgElevated }}
            >
              <GenesisAvatar className={GENESIS_AVATAR_SIZE.header} />
            </Link>
          )}
          <div
            className="flex min-w-0 flex-1 max-w-full items-end gap-2 rounded-2xl border-2 p-1.5"
            style={{ borderColor: GENESIS_ATMOSPHERE.violet, backgroundColor: GENESIS_ATMOSPHERE.bgElevated }}
          >
            {/* The one control that opens everything else. Deliberately quiet
                — outlined rather than filled — so the eye still lands on the
                field and the send arrow, which is what the two-row design was
                protecting when it labelled the icons "Add to J4" instead of
                letting them compete with the composer. Same 44px hit area as
                send. Hidden in Just Talk, where the mic is already primary. */}
            {!talkingOnly && (
              <button
                type="button"
                onClick={() => setAddOpen((open) => !open)}
                aria-expanded={addOpen}
                aria-label={addOpen ? "Hide what you can add to J4" : "Add photos, documents or a voice message"}
                title="Add to J4"
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border text-xl leading-none transition"
                style={{
                  borderColor: GENESIS_ATMOSPHERE.border,
                  color: GENESIS_ATMOSPHERE.textSecondary,
                  backgroundColor: addOpen ? GENESIS_ATMOSPHERE.bg : "transparent",
                }}
              >
                <span aria-hidden="true" className={`transition-transform duration-200 ${addOpen ? "rotate-45" : ""}`}>
                  +
                </span>
              </button>
            )}
            <textarea
              ref={messageInputRef}
              name="message"
              // Shortened with the tray change (2026-08-16). The long version
              // was carrying instructions the composer no longer has to give
              // now that "+" says where everything else lives.
              placeholder="Talk to J4…"
              rows={2}
              required
              onFocus={() => setGenesisComposing(true)}
              onBlur={() => setGenesisComposing(false)}
              onChange={(e) => {
                if (typeof window === "undefined") return;
                if (e.target.value) {
                  window.sessionStorage.setItem(DRAFT_STORAGE_KEY, e.target.value);
                } else {
                  window.sessionStorage.removeItem(DRAFT_STORAGE_KEY);
                }
              }}
              className="min-w-0 max-h-40 min-h-[4.5rem] flex-1 resize-none bg-transparent py-2.5 pl-2 text-[15px] text-[#f4f2fb] placeholder:text-[rgba(244,242,251,0.45)] focus:outline-none"
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
      </div>
    </form>
  );
}
