"use client";

import { useState } from "react";

// THE ONE PLACE GENESIS ASKS ABOUT GROWTH POINTS.
//
// ============ GLOBAL, DELIBERATELY (2026-08-28) ========================
//
// Sean: "This should be a global Genesis behavior for every Growth Point-
// consuming action, not something implemented separately for Creation Station,
// Social, or individual features."
//
// So this component is the question, and features supply the sentence. The
// alternative is three features asking three different ways, one of them
// forgetting the balance, and a fourth quietly not asking at all.
//
// ============ WHAT IT REFUSES TO DO ====================================
//
// It never appears during a workflow. "Growth Point costs should never be
// presented during the workflow. The cost is disclosed only at the final
// commitment point, immediately before the action executes." A surface that
// renders this on load rather than on press has misread it — the button that
// opens it should say what the action is, not what it costs.

export interface GrowthPointQuote {
  cost: number;
  balance: number;
  affordable: boolean;
  /** Why it is being asked. Drives the one sentence that changes. */
  reason:
    | "not-metered"
    | "never-asked"
    | "cost-increased"
    | "insufficient-balance"
    | "caller-insists"
    | "preference-set";
}

export function GrowthPointConfirm({
  quote,
  title = "Ready to continue?",
  /** What this will do, in the owner's terms. The feature's own sentence. */
  description,
  confirmLabel = "Continue",
  busy = false,
  onCancel,
  onConfirm,
}: {
  quote: GrowthPointQuote;
  title?: string;
  description: string;
  confirmLabel?: string;
  busy?: boolean;
  onCancel: () => void;
  /** `dontAskAgain` is passed up so the caller persists it with the action. */
  onConfirm: (options: { dontAskAgain: boolean }) => void;
}) {
  const [dontAskAgain, setDontAskAgain] = useState(false);
  const points = quote.cost === 1 ? "1 Growth Point" : `${quote.cost} Growth Points`;

  return (
    <div className="rounded-xl border border-black/[.10] bg-white p-4 dark:border-white/[.14] dark:bg-zinc-900">
      <p className="text-[14px] font-medium">{title}</p>
      <p className="mt-2 text-[13px] text-zinc-500">{description}</p>

      <p className="mt-2 text-[13px] text-zinc-500">
        You have {quote.balance} Growth {quote.balance === 1 ? "Point" : "Points"}. This costs{" "}
        {points}.
      </p>

      {!quote.affordable && (
        <p className="mt-2 text-[13px] text-amber-600 dark:text-amber-400">
          That is more than you have right now.
        </p>
      )}

      {/* WHY THEY ARE BEING ASKED AGAIN, when they had said not to. Without
          this, an override reads as the preference having been ignored. */}
      {quote.reason === "cost-increased" && (
        <p className="mt-2 text-[13px] text-zinc-500">
          This one costs more than the actions you asked us not to check, so we are checking.
        </p>
      )}

      {/* Offered only when it would actually mean something. Someone being
          asked because they cannot afford it, or because this action always
          asks, would be agreeing to something that will not hold. */}
      {(quote.reason === "never-asked" || quote.reason === "cost-increased") && quote.affordable && (
        <label className="mt-3 flex items-center gap-2 text-[13px] text-zinc-500">
          <input
            type="checkbox"
            checked={dontAskAgain}
            onChange={(event) => setDontAskAgain(event.target.checked)}
            className="h-4 w-4"
          />
          Don&apos;t ask me about Growth Points again
        </label>
      )}

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-full px-4 py-2 text-[13px] text-zinc-500 transition hover:bg-black/[.05] dark:hover:bg-white/[.08]"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={busy || !quote.affordable}
          onClick={() => onConfirm({ dontAskAgain })}
          className="rounded-full bg-[var(--brand-accent,#6366f1)] px-4 py-2 text-[13px] font-medium text-white transition disabled:opacity-40"
        >
          {busy ? "Working…" : confirmLabel}
        </button>
      </div>
    </div>
  );
}
