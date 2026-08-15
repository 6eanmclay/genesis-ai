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
// Lowered from 0.015 after a real device heard nothing at all. A phone mic at
// arm's length on a quiet desk sits well under the value a laptop mic gives.
const SPEECH_RMS = 0.006;
// A hard ceiling, so a noisy room can never record forever.
const MAX_TURN_MS = 30000;
// If the meter is running and still hears nothing this long, the threshold or
// the microphone is wrong, and saying so beats listening forever in silence.
const NOTHING_HEARD_MS = 12000;
// Below this, whatever was captured is not speech worth sending.
const MIN_TURN_BYTES = 2000;
// When the meter never starts there is nothing to detect silence with, so a
// turn is a fixed window instead. Long enough for a real sentence, short
// enough that the loop still feels like a conversation.
const NO_METER_TURN_MS = 6000;

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
  // A real timer as well as the animation frame. requestAnimationFrame stops
  // firing when the screen sleeps or the tab is backgrounded, which would
  // leave a turn recording with nothing left to end it.
  const turnTimerRef = useRef<number | null>(null);
  // startListening restarts itself, which a const cannot reference from inside
  // its own definition. Held in a ref, assigned once it exists.
  const restartRef = useRef<() => void>(() => {});
  // Whether Talk Mode is meant to be running, which is NOT the same as the
  // visible state. On the very first tap the state is still "off" while the
  // microphone permission prompt is up, so anything that guards on the state
  // during that await cancels the start it was trying to protect. Intent has
  // to be its own flag, set the instant the owner taps.
  const armedRef = useRef(false);
  // ONE audio element, unlocked by the owner's own tap.
  //
  // iOS and Chrome only allow playback traceable to a user gesture. J4's reply
  // arrives several async hops later — recorder stop, upload, Whisper, the
  // model — so an Audio constructed at that moment is refused, silently. The
  // browser's own speechSynthesis is blocked for the same reason, which is why
  // the fallback never rescued it either. So the element is created and played
  // once during the tap, while a gesture is still in scope, then reused for
  // every reply of the session.
  const audioElRef = useRef<HTMLAudioElement | null>(null);

  const setBoth = useCallback((next: TalkState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const stopMeter = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (turnTimerRef.current !== null) {
      window.clearTimeout(turnTimerRef.current);
      turnTimerRef.current = null;
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
    // Switched off while the permission prompt was up. Checked against intent
    // rather than the visible state: the state is still "off" during the very
    // first prompt, so guarding on it here silently cancelled every first
    // start — the permission dialog appeared and then nothing happened.
    if (!armedRef.current) {
      stream.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      return;
    }

    const mimeType = pickMimeType();
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    const chunks: Blob[] = [];
    recorderRef.current = recorder;
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    let heardSpeech = false;
    // Whether the RMS meter actually started. Without this, a browser that
    // refuses an AudioContext leaves heardSpeech permanently false, every turn
    // is discarded as silence, and Talk Mode sits on "Listening" forever —
    // which is exactly what happened on the first real iPhone test.
    let meterRunning = false;
    recorder.onstop = () => {
      // A superseded recorder. teardownRecorder() clears the ref before
      // stopping, so this fires for recorders that have already been replaced
      // — acting on them would restart listening from a turn nobody is in,
      // which is how a teardown becomes an infinite loop.
      if (recorderRef.current !== recorder) return;
      stopMeter();
      const type = recorder.mimeType || mimeType || "audio/webm";
      const blob = new Blob(chunks, { type });
      // With no meter there is no way to know whether speech happened, so the
      // recording is sent and Whisper decides. Silently discarding it is what
      // made this hang.
      const worthSending = meterRunning ? heardSpeech : blob.size >= MIN_TURN_BYTES;
      if (!worthSending || blob.size < MIN_TURN_BYTES) {
        if (stateRef.current === "listening") restartRef.current();
        return;
      }
      setBoth("thinking");
      void (async () => {
        try {
          const text = (await transcribeRef.current(blob, type)).trim();
          if (!text) {
            // Transcription succeeded and returned nothing. Said out loud
            // rather than looped silently: a turn that quietly restarts looks
            // identical to one that failed, and that ambiguity has already
            // cost hours of blind debugging.
            setError("Recorded " + Math.round(blob.size / 1024) + "KB of " + type + ", got no words back.");
            if (stateRef.current === "thinking") restartRef.current();
            return;
          }
          setError(null);
          onUtteranceRef.current(text);
        } catch (err) {
          // The real reason, not a generic apology. Whatever failed here is
          // the only thing between a working loop and a broken one, so it
          // goes on screen where it can be read.
          const detail = err instanceof Error ? err.message : String(err);
          setError("Transcription failed: " + detail.slice(0, 120));
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
          // Heard nothing at all for long enough that something is wrong.
          // Say so rather than listening silently forever.
          if (!heardSpeech && Date.now() - startedAt > NOTHING_HEARD_MS) {
            setError("I can't hear anything. Check the microphone, then tap J4 again.");
            recorder.stop();
            return;
          }
          if (Date.now() - startedAt > MAX_TURN_MS) {
            recorder.stop();
            return;
          }
          rafRef.current = requestAnimationFrame(tick);
        };
        meterRunning = true;
        rafRef.current = requestAnimationFrame(tick);
      }
    } catch {
      // Without a meter this still records; the ceiling above ends the turn.
      // Degraded, not broken.
    }

    try {
      // A timeslice, not a bare start(). Without one, ondataavailable only
      // fires at stop, and some browsers — iOS Safari in particular — hand
      // back an empty or unplayable blob that way. Emitting a chunk a second
      // is the well-worn workaround.
      recorder.start(1000);
      // The backstop that actually ends a turn when the meter is unavailable,
      // and the ceiling when it is. Without this a turn could record until the
      // page was closed.
      turnTimerRef.current = window.setTimeout(
        () => {
          if (recorderRef.current === recorder && recorder.state === "recording") recorder.stop();
        },
        meterRunning ? MAX_TURN_MS : NO_METER_TURN_MS
      );
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
    armedRef.current = false;
    audioElRef.current?.pause();
    setBoth("off");
    releaseMic();
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
  }, [setBoth, releaseMic]);

  const start = useCallback(() => {
    setError(null);
    armedRef.current = true;
    // Unlock audio HERE, inside the gesture, or J4 can never be heard.
    // Playing a moment of real silence is what performs the unlock; nothing is
    // audible, and a refusal is not a reason to stop Talk Mode starting.
    if (typeof window !== "undefined") {
      const el = audioElRef.current ?? new Audio();
      audioElRef.current = el;
      el.preload = "auto";
      el.src =
        "data:audio/mp3;base64,//uQxAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAACcQCA" +
        "gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgP////////////////////////" +
        "//////////////////8AAAAATGF2YzU4LjEzAAAAAAAAAAAAAAAAJAAAAAAAAAAAAnEaJ1kAAA==";
      el.play().catch(() => {});
    }
    // Shown as listening immediately, before the microphone is even open. A
    // tap that lights nothing up until permission resolves reads as a dead
    // control, and on a first run that wait includes a system dialog.
    setBoth("listening");
    void startListening();
  }, [setBoth, startListening]);

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
          // The already-unlocked element, never a new one: a fresh Audio here
          // carries no gesture and is refused by the autoplay policy.
          const audio = audioElRef.current ?? new Audio();
          audioElRef.current = audio;
          audio.onended = () => {
            URL.revokeObjectURL(url);
            resume();
          };
          audio.onerror = () => {
            URL.revokeObjectURL(url);
            resume();
          };
          audio.src = url;
          try {
            await audio.play();
            return;
          } catch (playErr) {
            URL.revokeObjectURL(url);
            const why = playErr instanceof Error ? playErr.name : "blocked";
            setError("Couldn't play J4's voice (" + why + "). Tap J4 again.");
            resume();
            return;
          }
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
