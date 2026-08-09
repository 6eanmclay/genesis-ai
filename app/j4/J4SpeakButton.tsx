"use client";

// J4 Voice Output (2026-08-08) — "J4 should be able to speak its written
// responses aloud, with Play/Pause/Resume and preferably seek/scrub
// controls. Keep the existing text response visible" (Sean). One shared
// control, used wherever a finished J4 reply renders (J4Workspace.tsx,
// J4Room.tsx) — never replaces the text, sits alongside it. On-demand,
// not automatic: synthesis has a real per-character cost (see
// j4VoiceOutput.ts's own usage recording), so nothing is generated until
// the owner actually taps to listen.
//
// Deliberately a native <audio controls> element once ready, not a
// custom player — real Play/Pause/seek/scrub for free, with none of the
// custom-transport-control bugs a hand-built player would risk. The
// backend synthesizes one complete audio file per tap (app/api/j4/speak),
// not a live concurrent stream — see that route's own comment for why
// that's the deliberate scope for this pass.
import { useEffect, useRef, useState } from "react";

type Status = "idle" | "loading" | "ready" | "error";

export function J4SpeakButton({ text }: { text: string }) {
  const [status, setStatus] = useState<Status>("idle");
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const audioUrlRef = useRef<string | null>(null);

  // Real browser resource — revoke the object URL when this message
  // scrolls out of the DOM (conversation list unmounts old entries) or a
  // fresh listen replaces it, not just on page unload.
  useEffect(() => {
    audioUrlRef.current = audioUrl;
  }, [audioUrl]);
  useEffect(() => {
    return () => {
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    };
  }, []);

  async function handleListen() {
    setStatus("loading");
    setErrorMessage(null);
    try {
      const response = await fetch("/api/j4/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setErrorMessage(body?.error || "Couldn't play that back.");
        setStatus("error");
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      setAudioUrl(url);
      setStatus("ready");
    } catch {
      setErrorMessage("Couldn't play that back — check your connection and try again.");
      setStatus("error");
    }
  }

  if (status === "ready" && audioUrl) {
    return (
      <audio controls autoPlay src={audioUrl} className="mt-1.5 h-8 max-w-full" style={{ width: 220 }} />
    );
  }

  return (
    <div className="mt-1.5 flex items-center gap-2">
      <button
        type="button"
        onClick={handleListen}
        disabled={status === "loading"}
        aria-label="Listen to J4's reply"
        title="Listen to J4's reply"
        className="flex items-center gap-1 rounded-full px-2 py-1 text-xs text-[rgba(244,242,251,0.62)] transition hover:bg-white/[.06] disabled:opacity-50"
      >
        {status === "loading" ? (
          <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />
        ) : (
          <span aria-hidden="true">🔊</span>
        )}
        {status === "loading" ? "Loading…" : "Listen"}
      </button>
      {status === "error" && errorMessage && <span className="text-xs text-red-400">{errorMessage}</span>}
    </div>
  );
}
