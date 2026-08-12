"use client";

import { useState } from "react";
import { reviewBusinessWithGenesis } from "./ai-actions";
import { callGenesisAction } from "@/lib/dashboard/submitGenesisAction";
import { SubmitButton } from "./SubmitButton";

// Reliability hardening — reviewBusinessWithGenesis directly calls
// runCognitiveReview(), a real, regularly 15-40+ second AI call (measured
// live this session) — the other confirmed long-running action sharing the
// same raw-form vulnerability class as GenesisAssistant's chat send (see
// lib/dashboard/submitGenesisAction.ts's own comment). Extracted as one
// shared component rather than fixed twice — app/dashboard/page.tsx and
// app/dashboard/analytics/page.tsx rendered byte-identical markup for this
// before this pass, just with a different className.
export function ReviewBusinessButton({ className }: { className: string }) {
  const [error, setError] = useState<string | null>(null);

  async function handleReview() {
    setError(null);
    const result = await callGenesisAction(() => reviewBusinessWithGenesis());
    if (!result.ok) setError(result.message);
  }

  return (
    <>
      <form action={handleReview}>
        <SubmitButton
          pendingText="Reviewing..."
          laterPendingText="Still reviewing — a full business review can take a little longer..."
          className={className}
        >
          Ask J4 to Review My Business
        </SubmitButton>
      </form>
      {error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </>
  );
}
