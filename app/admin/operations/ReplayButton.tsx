"use client";

import { useState, useTransition } from "react";
import { replayDeliveryAction } from "./actions";
import type { ReplayOutcome } from "@/lib/webhooks/replay";

// THE ONE BUTTON ON THIS PAGE THAT CHANGES ANYTHING.
//
// ============ IT SHOWS WHAT HAPPENED, NOT THAT IT WAS CLICKED ==========
//
// replayDelivery answers with one of four states and this renders all four,
// because the three that are not "replayed" are the ones an operator needs.
// A button that goes grey and says "done" would report a refusal as a success.
//
// Nothing is decided here. The refusals come back from the server already
// worded; this component chooses a colour and nothing else. The UI is not the
// security boundary and it is not the rules boundary either.

function describe(outcome: ReplayOutcome): { tone: string; text: string } {
  switch (outcome.status) {
    case "replayed":
      return { tone: "text-emerald-700 dark:text-emerald-400", text: "Replayed — the handler completed and the delivery is processed." };
    case "failed":
      return { tone: "text-amber-700 dark:text-amber-400", text: `Failed again — ${outcome.error}. Still replayable.` };
    case "refused":
      return { tone: "text-zinc-600 dark:text-zinc-400", text: `Refused — ${outcome.reason}` };
    default:
      return { tone: "text-zinc-600 dark:text-zinc-400", text: "Unknown result." };
  }
}

export function ReplayButton({ deliveryId, replayable }: { deliveryId: string; replayable: boolean }) {
  const [pending, startTransition] = useTransition();
  const [outcome, setOutcome] = useState<ReplayOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!replayable) {
    // Named, not hidden. An operator who cannot replay a Stripe delivery should
    // learn why here rather than hunting for a button that was never drawn.
    return <span className="text-xs text-zinc-500 dark:text-zinc-400">No replay handler for this provider</span>;
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            try {
              setOutcome(await replayDeliveryAction(deliveryId));
            } catch (e) {
              // Includes the authorization refusal. Shown rather than swallowed.
              setError(e instanceof Error ? e.message : "The replay could not be attempted.");
            }
          })
        }
        className="rounded-lg border border-black/[.12] px-3 py-1.5 text-xs font-medium text-black transition hover:bg-black/[.04] disabled:opacity-50 dark:border-white/[.15] dark:text-zinc-100 dark:hover:bg-white/[.06]"
      >
        {pending ? "Replaying…" : "Replay"}
      </button>
      {outcome && <span className={`text-xs ${describe(outcome).tone}`}>{describe(outcome).text}</span>}
      {error && <span className="text-xs text-rose-700 dark:text-rose-400">{error}</span>}
    </div>
  );
}
