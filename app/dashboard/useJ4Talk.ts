"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Talk Mode: a continuous conversation with J4 (2026-08-14).
//
// Sean's shape: "J4 orb activates → listen → I speak → Whisper transcribes →
// same J4 brain/conversation processes it → ElevenLabs speaks J4's response →
// automatically return to listening. No manual tap between every exchange."
//
// So this is a turn-taking loop, not a recorder. A memo ends when a button is
// released; a turn here ends when the owner stops talking.
//
// WHY WHISPER LISTENS, NOT THE BROWSER. This first used the Web Speech API,
// which is free and instant on Chrome. On a real iPhone it stalled: Safari's
// implementation does not hold a continuous session reliably, so listening
// sometimes never caught anything at all. Whisper is already paid for and
// already proven in this codebase — it is what voice memos use — and it
// behaves the same on every device. The cost is about a second per turn,
// which is the right trade against a loop that sometimes does not work.
//
// TURNS ARE DETECTED BY SILENCE. The recorder runs while the owner speaks and
// stops after a beat of quiet. Speech must be heard first, so a silent room
// never sends an empty turn and never pays to transcribe nothing.
//
// ONE CONVERSATION. This produces text and consumes text. What it hears goes
// into the same composer a typed message uses, and what J4 says back is the
// same reply that lands in the same history. Voice is a surface onto that one
// conversation, never a second one.
//
// WHY IT MUST STOP LISTENING WHILE SPEAKING. Otherwise J4 hears himself,
// transcribes it, and answers his own reply — a conversation with nobody in
// it. The recorder is torn down before speech starts and rebuilt after.

export type TalkState = "off" | "listening" | "thinking" | "speaking";

// How long a pause means "I have finished talking", and how loud counts as
// talking at all. Deliberately forgiving: cutting someone off mid-sentence is
// far worse than waiting an extra moment.
const SILENCE_MS = 1400;
const SPEECH_RMS = 0.015;
// A hard ceiling, so a noisy room can never record forever.
const MAX_TURN_MS = 30000;
// Below this, whatever was captured is not speech worth sending.
const MIN_TURN_BYTES = 2000;

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  for (const t of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"]) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return undefined;
}

/** Whether this browser can hold a spoken conversation at all. */
export function canTalk(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== "undefined"
  );
}

export function useJ4Talk({
  onUtterance,
  transcribe,
}: {
  /** A finished spoken turn, ready to send through the one composer. */
  onUtterance: (text: string) => void;
  /** Audio in, text out. The same Whisper path voice memos already use. */
  transcribe: (blob: Blob, mimeType: string) => Promise<string>;
}) {
  const [state, setState] = useState<TalkState>("off");
  const [error, setError] = useState<string | null>(null);

  // Read inside callbacks that outlive a render, so they never act on a stale
  // idea of whether Talk Mode is still on.
  const stateRef = useRef<TalkState>("off");
  const onUtteranceRef = useRef(onUtterance);
  const transcribeRef = useRef(transcribe);
  useEffect(() => {
    onUtteranceRef.current = onUtterance;
    transcribeRef.current = transcribe;
  }, [onUtterance, transcribe]);

  // The microphone stream is opened once and kept, not reopened per turn:
  // calling getUserMedia every turn re-prompts on some browsers and adds
  // latency to every single exchange.
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  // startListening restarts itself, which a const cannot reference from inside
  // its own definition. Held in a ref, assigned once it exists.
  const restartRef = useRef<() => void>(() => {});

  const setBoth = useCallback((next: TalkState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const stopMeter = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const teardownRecorder = useCallback(() => {
    stopMeter();
    const rec = recorderRef.current;
    recorderRef.current = null;
    if (rec && rec.state !== "inactive") {
      try {
        rec.stop();
      } catch {
        // Already stopped; nothing to recover.
      }
    }
  }, [stopMeter]);

  const releaseMic = useCallback(() => {
    teardownRecorder();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    const ctx = audioCtxRef.current;
    audioCtxRef.current = null;
    if (ctx) void ctx.close().catch(() => {});
  }, [teardownRecorder]);

  const startListening = useCallback(async () => {
    if (!canTalk()) {
      setError("This browser can't record. Use the microphone in the conversation instead.");
      setBoth("off");
      return;
    }
    teardownRecorder();

    let stream = streamRef.current;
    if (!stream || stream.getTracks().every((t) => t.readyState === "ended")) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamRef.current = stream;
      } catch {
        setError("Microphone access is blocked. Allow it for this site and tap J4 again.");
        setBoth("off");
        return;
      }
    }
    // Talk Mode may have been switched off while the permission prompt was up.
    if (stateRef.current === "off") return;

    const mimeType = pickMimeType();
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    const chunks: Blob[] = [];
    recorderRef.current = recorder;
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    let heardSpeech = false;
    recorder.onstop = () => {
      stopMeter();
      const type = recorder.mimeType || mimeType || "audio/webm";
      const blob = new Blob(chunks, { type });
      // Nothing said, or the turn ended before any speech: listen again rather
      // than sending silence to Whisper.
      if (!heardSpeech || blob.size < MIN_TURN_BYTES) {
        if (stateRef.current === "listening") restartRef.current();
        return;
      }
      setBoth("thinking");
      void (async () => {
        try {
          const text = (await transcribeRef.current(blob, type)).trim();
          if (!text) {
            if (stateRef.current === "thinking") restartRef.current();
            return;
          }
          onUtteranceRef.current(text);
        } catch {
          setError("Couldn't make out that one. Try again.");
          if (stateRef.current === "thinking") restartRef.current();
        }
      })();
    };

    // Silence detection: a turn ends when the owner stops talking, which is the
    // whole difference between this and a memo button.
    try {
      const AudioCtor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      const ctx = audioCtxRef.current ?? (AudioCtor ? new AudioCtor() : null);
      if (ctx) {
        audioCtxRef.current = ctx;
        if (ctx.state === "suspended") await ctx.resume();
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        source.connect(analyser);
        const data = new Float32Array(analyser.fftSize);
        const startedAt = Date.now();
        let quietSince: number | null = null;

        const tick = () => {
          if (recorderRef.current !== recorder || recorder.state !== "recording") return;
          analyser.getFloatTimeDomainData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i += 1) sum += data[i] * data[i];
          const rms = Math.sqrt(sum / data.length);

          if (rms > SPEECH_RMS) {
            heardSpeech = true;
            quietSince = null;
          } else if (heardSpeech) {
            quietSince = quietSince ?? Date.now();
            if (Date.now() - quietSince > SILENCE_MS) {
              recorder.stop();
              return;
            }
          }
          if (Date.now() - startedAt > MAX_TURN_MS) {
            recorder.stop();
            return;
          }
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      }
    } catch {
      // Without a meter this still records; the ceiling above ends the turn.
      // Degraded, not broken.
    }

    try {
      recorder.start();
      setError(null);
      setBoth("listening");
    } catch {
      setError("Couldn't start listening. Tap J4 to try again.");
      setBoth("off");
    }
  }, [setBoth, stopMeter, teardownRecorder]);

  useEffect(() => {
    restartRef.current = () => {
      void startListening();
    };
  }, [startListening]);

  const stop = useCallback(() => {
    setBoth("off");
    releaseMic();
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
  }, [setBoth, releaseMic]);

  const start = useCallback(() => {
    setError(null);
    void startListening();
  }, [startListening]);

  /**
   * Speaks J4's reply, then goes back to listening.
   *
   * ElevenLabs first, the browser's own synthesis as a fallback so a missing
   * key degrades the voice rather than breaking the loop. Listening resumes
   * when the audio ends, which is what closes this into a conversation.
   */
  const speak = useCallback(
    async (text: string) => {
      if (stateRef.current === "off") return;
      const spoken = text.trim();
      if (!spoken) {
        void startListening();
        return;
      }
      setBoth("speaking");
      teardownRecorder();

      const resume = () => {
        if (stateRef.current === "speaking") void startListening();
      };

      try {
        const res = await fetch("/api/j4/speak", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: spoken }),
        });
        if (res.ok) {
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          const audio = new Audio(url);
          audio.onended = () => {
            URL.revokeObjectURL(url);
            resume();
          };
          audio.onerror = () => {
            URL.revokeObjectURL(url);
            resume();
          };
          await audio.play();
          return;
        }
      } catch {
        // Fall through to the browser's own voice.
      }

      if (typeof window === "undefined" || !("speechSynthesis" in window)) {
        resume();
        return;
      }
      const utterance = new SpeechSynthesisUtterance(spoken);
      utterance.onend = resume;
      utterance.onerror = resume;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
    },
    [setBoth, startListening, teardownRecorder]
  );

  // A turn must never hang silently. Two different faults have already
  // produced a "Thinking" that never ended. Both are fixed, but a voice
  // interface that can wait forever is one bad turn from looking broken again,
  // so this is a floor under every future cause: after a minute with no reply,
  // say so and start listening again.
  useEffect(() => {
    if (state !== "thinking") return;
    const timer = window.setTimeout(() => {
      if (stateRef.current !== "thinking") return;
      setError("J4 didn't answer that one. Try again.");
      void startListening();
    }, 60000);
    return () => window.clearTimeout(timer);
  }, [state, startListening]);

  // Never leave the microphone open behind a closed page.
  useEffect(() => {
    return () => {
      releaseMic();
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, [releaseMic]);

  return { state, error, start, stop, speak };
}
