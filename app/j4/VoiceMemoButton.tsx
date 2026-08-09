"use client";

// J4 Voice Memos — moved out of J4Workspace.tsx (2026-08-08, J4 Room
// Phase 1) so J4Room.tsx can reuse the exact same recording/upload/
// transcribe implementation, not a second "big mic" component. Pure move
// — no behavior change from the original definition. See J4Workspace.tsx's
// own git history for this component's real incident history (Android
// permission recovery, stream-reuse fix, Priority 3 responsiveness).

import { useEffect, useRef, useState, useTransition } from "react";
import { upload as blobUpload } from "@vercel/blob/client";
import { GENESIS_ATMOSPHERE } from "@/lib/dashboard/genesisAtmosphere";
import { callGenesisAction } from "@/lib/dashboard/submitGenesisAction";
import { ALLOWED_VOICE_MEMO_CONTENT_TYPES, MAX_VOICE_MEMO_BYTES } from "@/lib/voice/voiceMemoFile";

function randomAssetKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

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

export function VoiceMemoButton({
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
  // size changes, so there is exactly one voice-memo implementation, never
  // a second "big mic" component. J4 Room (Phase 1) reuses this same
  // "large" variant for its own pre-conversation mic-primary moment.
  size?: "default" | "large";
}) {
  const [isPending, startTransition] = useTransition();
  const [isRecording, setIsRecording] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  // Real production finding (Sean, 2026-08-09): "I recorded something,
  // lost my thought, and J4 received confusing input... stopping a
  // recording must NOT automatically send it to J4." Recording no longer
  // uploads/transcribes/sends the instant it stops — it lands here first,
  // playable, with an explicit Delete or Send to J4 choice. Nothing about
  // this recording exists to the server (no upload, no transcription, no
  // conversation turn, no business context) until "Send to J4" is
  // actually tapped — Delete just revokes the local object URL and this
  // state, a purely client-side no-op as far as J4/the server ever knows.
  const [pendingBlob, setPendingBlob] = useState<{
    blob: Blob;
    url: string;
    contentType: string;
    extension: string;
    durationSeconds: number;
  } | null>(null);
  // recorder.onstop's own closure is created once per startRecording()
  // call, so reading elapsedSeconds directly inside it would capture a
  // stale value from that render, not the real final duration — this ref
  // is updated alongside the state on every tick specifically so onstop
  // can read the genuinely-current value.
  const elapsedSecondsRef = useRef(0);
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
  // unmounts (leaving /j4 or /j4/room) even if a recording is somehow
  // still active, not left running in the background. This is now the
  // ONLY place the stream's tracks get stopped — not after every
  // individual recording.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== "inactive") recorder.stop();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
  }, []);
  // A pending (not-yet-sent) recording's object URL is a real browser
  // resource too — revoked if the owner navigates away mid-review without
  // ever choosing Delete or Send. A ref (not reading pendingBlob directly)
  // so this effect's own cleanup always sees the latest value without
  // needing to re-run on every pendingBlob change.
  const pendingBlobRef = useRef(pendingBlob);
  useEffect(() => {
    pendingBlobRef.current = pendingBlob;
  }, [pendingBlob]);
  useEffect(() => {
    return () => {
      if (pendingBlobRef.current) URL.revokeObjectURL(pendingBlobRef.current.url);
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
        // Real production finding (Sean, 2026-08-09) — stopping a
        // recording used to upload+transcribe+send it immediately. Now it
        // only ever lands in review: nothing touches the server, nothing
        // becomes conversation/business context, until the owner
        // explicitly taps "Send to J4" (see handleSendToJ4 below).
        // Deleting from here is a pure client-side discard — J4 never
        // learns this recording existed at all.
        const url = URL.createObjectURL(blob);
        setPendingBlob({ blob, url, contentType, extension, durationSeconds: elapsedSecondsRef.current });
      };

      mediaRecorderRef.current = recorder;
      recorder.start();
      setIsRecording(true);
      setElapsedSeconds(0);
      elapsedSecondsRef.current = 0;
      timerRef.current = setInterval(() => {
        setElapsedSeconds((s) => {
          const next = s + 1;
          elapsedSecondsRef.current = next;
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

  // Pure client-side discard — revokes the local object URL and clears
  // state. No request of any kind is ever made; the server, J4's
  // conversation, and J4's business context never learn this recording
  // existed.
  function handleDeleteRecording() {
    if (pendingBlob) URL.revokeObjectURL(pendingBlob.url);
    setPendingBlob(null);
  }

  // The one real boundary where a recording becomes J4 input — same real
  // upload/transcribe/onTranscribed sequence this used to run
  // automatically on stop, now gated behind an explicit tap.
  function handleSendToJ4() {
    if (!pendingBlob) return;
    const { blob, contentType, extension, url } = pendingBlob;
    URL.revokeObjectURL(url);
    setPendingBlob(null);
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
  }

  return (
    <div className="relative">
      <button
        type="button"
        disabled={isPending || !!pendingBlob}
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

      {/* Voice memo review (2026-08-09) — "Record → Stop → Review →
          Delete OR Send to J4... stopping a recording must NOT
          automatically send it to J4" (Sean). Same absolutely-positioned
          popover pattern as the mic-blocked panel above, so it never
          shifts the composer's own layout. Real playback via a genuine
          local object URL — nothing here has touched the network yet. */}
      {pendingBlob && (
        <div
          className="absolute bottom-full left-0 z-10 mb-2 w-72 rounded-xl border p-3 text-xs shadow-lg"
          style={{ borderColor: GENESIS_ATMOSPHERE.violet, backgroundColor: GENESIS_ATMOSPHERE.bgElevated }}
        >
          <p className="font-medium text-[#f4f2fb]">
            Voice memo ready · {Math.floor(pendingBlob.durationSeconds / 60)}:
            {String(pendingBlob.durationSeconds % 60).padStart(2, "0")}
          </p>
          <audio controls src={pendingBlob.url} className="mt-2 h-8 w-full" />
          <div className="mt-2.5 flex gap-2">
            <button
              type="button"
              onClick={handleSendToJ4}
              className="rounded-full px-3 py-1 text-xs font-medium text-white hover:opacity-90"
              style={{ backgroundColor: GENESIS_ATMOSPHERE.violet }}
            >
              Send to J4 →
            </button>
            <button
              type="button"
              onClick={handleDeleteRecording}
              className="rounded-full px-3 py-1 text-xs text-[rgba(244,242,251,0.62)] hover:bg-white/[.06]"
            >
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
