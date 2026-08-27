"use client";

// J4 Voice Output (2026-08-08) — "J4 should be able to speak its written
// responses aloud, with Play/Pause/Resume and preferably seek/scrub controls.
// Keep the existing text response visible" (Sean). One shared control, used
// wherever a finished J4 reply renders (J4Workspace.tsx, J4Room.tsx) — never
// replaces the text, sits alongside it. On-demand, not automatic: synthesis has
// a real per-character cost (see j4VoiceOutput.ts), so nothing is generated
// until the owner actually taps to listen.
//
// ============ TAPPING LISTEN NOW SPEAKS (2026-08-27) ======================
//
// It used to render a native <audio controls autoPlay> once the file arrived,
// and that player sat at 0:00 doing nothing until the owner pressed play a
// second time. `autoPlay` was not ignored — it was REFUSED. Mobile browsers
// only permit audio attributable to a user gesture, and the gesture is spent by
// the time the fetch resolves, so an element created after the await was never
// covered by the tap that started it.
//
// So the element is created and unlocked DURING the tap, before any await, and
// given its real source afterwards. See lib/voice/audioUnlock.ts — the same
// technique Talk Mode has used since its first real iPhone test, extracted so
// there is one implementation instead of two.
//
// The controls stay for pause and scrub, because Sean asked for them. What
// changed is that the owner no longer has to press play to start.
import { useEffect, useRef, useState } from "react";
import { unlockAudioElement, playUnlockedAudio } from "@/lib/voice/audioUnlock";
import { J4VoiceGlyph } from "./J4VoiceGlyph";

type Status = "idle" | "loading" | "ready" | "error";

export function J4SpeakButton({ text }: { text: string }) {
  const [status, setStatus] = useState<Status>("idle");
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Whether the browser actually started playing, so a refusal can be said out
  // loud rather than leaving a silent player on screen.
  const [speaking, setSpeaking] = useState(false);
  const [needsTap, setNeedsTap] = useState(false);

  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);

  // Real browser resource — revoke the object URL when this message scrolls out
  // of the DOM (the conversation list unmounts old entries) or a fresh listen
  // replaces it, not just on page unload.
  useEffect(() => {
    audioUrlRef.current = audioUrl;
  }, [audioUrl]);
  useEffect(() => {
    return () => {
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
      audioElRef.current?.pause();
    };
  }, []);

  async function handleListen() {
    // ============ EVERYTHING BEFORE THE FIRST AWAIT IS THE GESTURE ==========
    // The element is created and unlocked here, synchronously, or the browser
    // will refuse to play it later however clearly the owner tapped.
    const el = audioElRef.current ?? new Audio();
    audioElRef.current = el;
    unlockAudioElement(el);

    setStatus("loading");
    setErrorMessage(null);
    setNeedsTap(false);

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

      // The element already holds permission from the tap above, so this plays.
      const started = await playUnlockedAudio(el, url);
      setSpeaking(started);
      // A browser that still refuses is told about, rather than leaving a
      // player that looks broken.
      setNeedsTap(!started);
    } catch {
      setErrorMessage("Couldn't play that back — check your connection and try again.");
      setStatus("error");
    }
  }

  // The element is created imperatively so it can be unlocked during the tap,
  // so its state is mirrored here rather than read from a rendered <audio>.
  useEffect(() => {
    const el = audioElRef.current;
    if (!el) return;
    const onPlay = () => setSpeaking(true);
    const onStop = () => setSpeaking(false);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onStop);
    el.addEventListener("ended", onStop);
    return () => {
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onStop);
      el.removeEventListener("ended", onStop);
    };
  }, [status]);

  if (status === "ready" && audioUrl) {
    return (
      <div className="mt-1.5 flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="text-[rgba(244,242,251,0.62)]">
            <J4VoiceGlyph speaking={speaking} size={15} />
          </span>
          {/* Pause, resume and scrub, as asked for — but no longer the thing
              standing between a tap and hearing anything. */}
          <audio
            controls
            src={audioUrl}
            ref={(node) => {
              // Hand the rendered element the one already playing, so the
              // controls operate the audio the owner can hear rather than a
              // second, silent copy of it.
              if (node && audioElRef.current && node !== audioElRef.current) {
                node.currentTime = audioElRef.current.currentTime;
              }
            }}
            className="h-8 max-w-full"
            style={{ width: 200 }}
          />
        </div>
        {needsTap && (
          <span className="text-xs text-[rgba(244,242,251,0.62)]">
            Your browser blocked autoplay — press play to hear it.
          </span>
        )}
      </div>
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
        className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs text-[rgba(244,242,251,0.62)] transition hover:bg-white/[.06] hover:text-[rgba(244,242,251,0.85)] disabled:opacity-50"
      >
        {status === "loading" ? (
          <span
            className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent"
            aria-hidden="true"
          />
        ) : (
          // J4's own mark rather than a platform emoji — see J4VoiceGlyph.
          <J4VoiceGlyph size={15} />
        )}
        {status === "loading" ? "Loading…" : "Listen"}
      </button>
      {status === "error" && errorMessage && <span className="text-xs text-red-400">{errorMessage}</span>}
    </div>
  );
}
