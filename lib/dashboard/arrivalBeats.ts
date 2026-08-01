"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// The Arrival Experience's one reusable piece (see memory
// project_arrival_experience_milestone.md — "choose the framework" over
// polishing any one animation). A beat is one line of real Genesis
// narration with real timing around it. This sequencer knows nothing about
// creation vs. return, mobile vs. desktop, or what the words say — it only
// plays a known list of beats in order, on a timer. Phase-tied narration
// (creation's real generation-status polling) is driven externally and
// does NOT go through this — it has no fixed schedule to sequence, only
// real async state to reflect. This hook is for beats whose *content* is
// already fully known, just their *pacing* needs to feel deliberate.
export interface Beat {
  text: string;
  // Real stillness before this beat appears — the "genuine pause" the
  // frozen design calls for at the completion moment. Default 0.
  pauseBeforeMs?: number;
  // How long this beat stays the active one before advancing. Default
  // below. The exact numbers here are the one thing expected to change
  // repeatedly — kept as simple, named constants precisely so tuning them
  // later never touches the sequencing logic itself.
  holdMs?: number;
}

const DEFAULT_HOLD_MS = 1800;

export function useBeatSequence(
  beats: Beat[],
  opts: { autoStart?: boolean; onComplete?: () => void } = {}
) {
  const [index, setIndex] = useState(() => (opts.autoStart ? 0 : -1)); // -1 = not started
  const [done, setDone] = useState(false);
  const onCompleteRef = useRef(opts.onComplete);
  useEffect(() => {
    onCompleteRef.current = opts.onComplete;
  });

  const start = useCallback(() => {
    setIndex(0);
    setDone(false);
  }, []);

  // React's documented "adjusting state when a prop changes" pattern
  // (react.dev/reference/react/useState#storing-information-from-previous-renders):
  // callers like CreateBusinessArrival mount this hook with autoStart still
  // false (generation in progress) and flip it true later once the real
  // completion beat should play — that has to be handled during render, not
  // in a mount-only effect (which would only ever see the very first value)
  // and not in a plain effect keyed on autoStart (an effect reacting to
  // React's own prop, not a real external system, is exactly what the
  // set-state-in-effect rule flags).
  const [prevAutoStart, setPrevAutoStart] = useState(opts.autoStart);
  if (opts.autoStart !== prevAutoStart) {
    setPrevAutoStart(opts.autoStart);
    if (opts.autoStart) {
      setIndex(0);
      setDone(false);
    }
  }

  useEffect(() => {
    if (index < 0 || index >= beats.length) return;
    const beat = beats[index];
    const timer = setTimeout(
      () => {
        if (index === beats.length - 1) {
          setDone(true);
          onCompleteRef.current?.();
        } else {
          setIndex((i) => i + 1);
        }
      },
      (beat.pauseBeforeMs ?? 0) + (beat.holdMs ?? DEFAULT_HOLD_MS)
    );
    return () => clearTimeout(timer);
  }, [index, beats]);

  return {
    activeBeat: index >= 0 && index < beats.length ? beats[index] : null,
    index,
    done,
    start,
  };
}
