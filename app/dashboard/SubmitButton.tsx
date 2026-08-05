"use client";

import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { logClientEvent } from "./telemetry-actions";

// Family-beta instrumentation (v20) — `trackPerf` is opt-in and undefined by
// default, so every existing call site (including the public storefront's
// own checkout/newsletter buttons, which share this component) is
// byte-for-byte unchanged unless a caller explicitly asks to be measured.
// This is the one shared pending-state primitive nearly every dashboard
// form already funnels through via useFormStatus(), so it's the natural
// low-duplication place to answer "did this feel slow/frozen" — client-
// perceived wait (network + server), distinct from the real server-side
// duration captured separately for Genesis chat turns.
export interface SubmitButtonPerfTracking {
  label: string;
  storeId?: string;
  attemptKey?: string;
}

const FELT_SLOW_MS = 3000;

// Reliability hardening — real evidence (last night's incident) that
// "Genesis is thinking..." sitting static and unreadable for a long real
// wait reads as frozen, prompting a retry-tap rather than patience. This
// never cuts a genuine wait short; it only ever changes the label once one
// has genuinely gone on a while, so the owner knows Genesis is still
// working, not stuck.
const STILL_WORKING_THRESHOLD_MS = 8000;

export function SubmitButton({
  children,
  pendingText,
  // Optional — every existing call site that doesn't pass this renders
  // exactly as before, no staged behavior.
  laterPendingText,
  className,
  name,
  value,
  trackPerf,
}: {
  children: React.ReactNode;
  pendingText: string;
  laterPendingText?: string;
  className?: string;
  name?: string;
  value?: string;
  trackPerf?: SubmitButtonPerfTracking;
}) {
  const { pending, data } = useFormStatus();
  const startedAtRef = useRef<number | null>(null);
  const [showLaterText, setShowLaterText] = useState(false);

  // When several same-named submit buttons share one form (e.g. the brand
  // personality picker), a native form submission only includes the
  // actually-clicked button's name/value pair in FormData — every other
  // button's value is absent even though the whole form is pending. Use
  // that to show pendingText only on the button the user actually clicked;
  // siblings stay disabled (via the pending check below) but keep their
  // normal label instead of all flashing "Applying..." at once, which read
  // as the whole picker resetting rather than one choice being made.
  const isThisButtonPending =
    name !== undefined && value !== undefined
      ? pending && data?.get(name) === value
      : pending;

  useEffect(() => {
    if (!trackPerf) return;
    if (pending) {
      startedAtRef.current = Date.now();
      return;
    }
    const startedAt = startedAtRef.current;
    if (startedAt === null) return;
    startedAtRef.current = null;
    const durationMs = Date.now() - startedAt;
    logClientEvent({
      storeId: trackPerf.storeId,
      name: "perf.action_pending",
      category: "performance",
      attemptKey: trackPerf.attemptKey,
      durationMs,
      metadata: { label: trackPerf.label, feltSlow: durationMs > FELT_SLOW_MS },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  useEffect(() => {
    if (!laterPendingText || !isThisButtonPending) return;
    const timer = setTimeout(() => setShowLaterText(true), STILL_WORKING_THRESHOLD_MS);
    return () => {
      clearTimeout(timer);
      setShowLaterText(false);
    };
  }, [isThisButtonPending, laterPendingText]);

  const label = isThisButtonPending
    ? showLaterText && laterPendingText
      ? laterPendingText
      : pendingText
    : children;

  return (
    <button
      type="submit"
      name={name}
      value={value}
      disabled={pending}
      className={className}
    >
      {label}
    </button>
  );
}
