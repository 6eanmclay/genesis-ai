"use client";

import { useEffect, useRef } from "react";
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

export function SubmitButton({
  children,
  pendingText,
  className,
  name,
  value,
  trackPerf,
}: {
  children: React.ReactNode;
  pendingText: string;
  className?: string;
  name?: string;
  value?: string;
  trackPerf?: SubmitButtonPerfTracking;
}) {
  const { pending } = useFormStatus();
  const startedAtRef = useRef<number | null>(null);

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

  return (
    <button
      type="submit"
      name={name}
      value={value}
      disabled={pending}
      className={className}
    >
      {pending ? pendingText : children}
    </button>
  );
}
