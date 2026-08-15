"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Talk Mode: a continuous conversation with J4 (2026-08-14).
//
// Sean's correction, and the reason this is not the microphone:
//
//   "This is NOT a voice memo interaction. It must NOT be tap → record → send.
//    It should be: tap J4 → J4 becomes active/listening → user speaks → J4
//    responds aloud → user continues speaking → J4 continues responding."
//
// So this is a loop with a turn-taking state machine, not a recorder. The
// difference that matters in code: a memo ends when the owner releases a
// button, whereas this ends a turn when they stop speaking, sends it, waits,
// speaks the reply, and starts listening again without being asked.
//
// ONE CONVERSATION. This produces text and consumes text. What it hears goes
// into the same composer a typed message uses, and what J4 says back is the
// same reply that lands in the same history. Talk Mode is a presentation of
// that one conversation, never a second one.
//
// WHY BROWSER SPEECH. app/api/j4/speak returns 503 "Voice isn't set up yet"
// without an ELEVENLABS_API_KEY, and none is configured. The browser's own
// synthesis needs no key and no network, so Talk Mode works today rather than
// after a procurement step; ElevenLabs is tried first and this is the
// fallback, so the day a key exists the voice improves with no code change.
//
// WHY IT MUST STOP LISTENING WHILE SPEAKING. Without that, J4 hears himself,
// transcribes it, and answers his own reply — an infinite conversation with
// nobody in it. Recognition is torn down before speech starts and rebuilt
// after it ends, rather than merely ignored, because a suspended recogniser
// still holds the microphone on some browsers.

export type TalkState = "off" | "listening" | "thinking" | "speaking";

// Minimal shape of the Web Speech API. Not in lib.dom's default types, and
// deliberately not pulled from a dependency for four fields.
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function recognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Whether this browser can hold a spoken conversation at all. */
export function canTalk(): boolean {
  return recognitionCtor() !== null && typeof window !== "undefined" && "speechSynthesis" in window;
}

export function useJ4Talk({
  onUtterance,
}: {
  /** A finished spoken turn, ready to send through the one composer. */
  onUtterance: (text: string) => void;
}) {
  const [state, setState] = useState<TalkState>("off");
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  // Read inside callbacks that outlive a render, so they never act on a stale
  // idea of whether Talk Mode is still on.
  const stateRef = useRef<TalkState>("off");
  const onUtteranceRef = useRef(onUtterance);
  useEffect(() => {
    onUtteranceRef.current = onUtterance;
  }, [onUtterance]);
  // startListening restarts itself when a browser ends a session on silence,
  // which a const cannot reference from inside its own definition. Held in a
  // ref, assigned once it exists.
  const restartRef = useRef<() => void>(() => {});

  const setBoth = useCallback((next: TalkState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const teardownRecognition = useCallback(() => {
    const r = recognitionRef.current;
    recognitionRef.current = null;
    if (!r) return;
    r.onresult = null;
    r.onerror = null;
    r.onend = null;
    try {
      r.abort();
    } catch {
      // Already stopped. Nothing to do, and nothing worth surfacing.
    }
  }, []);

  const startListening = useCallback(() => {
    const Ctor = recognitionCtor();
    if (!Ctor) {
      setError("This browser can't listen. Use the microphone in the conversation instead.");
      setBoth("off");
      return;
    }
    teardownRecognition();

    const r = new Ctor();
    // continuous keeps the session open across pauses, which is what makes
    // this a conversation rather than a series of one-shot captures.
    r.continuous = true;
    r.interimResults = false;
    r.lang = "en-US";

    r.onresult = (event) => {
      const results = event.results;
      let finalText = "";
      for (let i = 0; i < results.length; i += 1) {
        const result = results[i];
        if (result.isFinal && result[0]) finalText += result[0].transcript;
      }
      const text = finalText.trim();
      if (!text) return;
      // A finished turn. Hand it off and wait, rather than keep listening
      // through J4's answer.
      setBoth("thinking");
      teardownRecognition();
      onUtteranceRef.current(text);
    };

    r.onerror = (event) => {
      // "no-speech" and "aborted" are ordinary in a conversation with pauses,
      // and must not end Talk Mode or show the owner an error.
      if (event.error === "no-speech" || event.error === "aborted") return;
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        setError("Microphone access is blocked. Allow it for this site and tap J4 again.");
        setBoth("off");
        return;
      }
      setError("Lost the microphone. Tap J4 to start again.");
      setBoth("off");
    };

    r.onend = () => {
      // Browsers end a session on their own after a silence. If Talk Mode is
      // still meant to be listening, start a fresh one so a pause in thought
      // does not end the conversation.
      if (stateRef.current === "listening") restartRef.current();
    };

    recognitionRef.current = r;
    try {
      r.start();
      setError(null);
      setBoth("listening");
    } catch {
      setError("Couldn't start listening. Tap J4 to try again.");
      setBoth("off");
    }
  }, [setBoth, teardownRecognition]);

  useEffect(() => {
    restartRef.current = startListening;
  }, [startListening]);

  const stop = useCallback(() => {
    setBoth("off");
    teardownRecognition();
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
  }, [setBoth, teardownRecognition]);

  const start = useCallback(() => {
    setError(null);
    startListening();
  }, [startListening]);

  /**
   * Speaks J4's reply, then goes back to listening.
   *
   * ElevenLabs first, browser synthesis when that is unavailable — which is
   * today, since no key is configured. Either way listening resumes when the
   * audio ends, which is what closes the loop into a conversation.
   */
  const speak = useCallback(
    async (text: string) => {
      if (stateRef.current === "off") return;
      const spoken = text.trim();
      if (!spoken) {
        startListening();
        return;
      }
      setBoth("speaking");
      teardownRecognition();

      const resume = () => {
        if (stateRef.current === "speaking") startListening();
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
    [setBoth, startListening, teardownRecognition]
  );

  // Never leave the microphone open behind a closed page.
  useEffect(() => {
    return () => {
      teardownRecognition();
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, [teardownRecognition]);

  return { state, error, start, stop, speak };
}
