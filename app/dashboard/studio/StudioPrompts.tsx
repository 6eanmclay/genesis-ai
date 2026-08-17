"use client";

import { useJ4Ask } from "../J4AskContext";

// Studio's recommendation chips (2026-08-17).
//
// They were text until now, deliberately — a control that only opened a chat
// box would have been a button pretending to be a capability. The capabilities
// are real now, so these send the request into the real conversation and J4
// does the work.
//
// THEY ARE NOT DESIGN OPERATIONS. Clicking one sends a sentence, exactly as if
// the owner had typed it. There is no hard-coded "make logo smaller" path
// behind them and there must never be: the moment a chip calls something the
// conversation cannot, Studio has become a design editor with a chat box
// attached, which is the thing this room is defined against.
//
// It also means every chip is honest by construction. If J4 cannot do what a
// chip asks, J4 says so in its own words — the chip cannot promise more than
// the conversation can deliver.

export function StudioPrompts({ prompts }: { prompts: string[] }) {
  const { ask, available } = useJ4Ask();

  // No provider means no conversation to send to. Render nothing rather than
  // dead controls.
  if (!available || prompts.length === 0) return null;

  return (
    <ul className="mt-3 flex flex-wrap gap-2">
      {prompts.map((phrase) => (
        <li key={phrase}>
          <button
            type="button"
            onClick={() => ask(phrase)}
            className="rounded-full border border-black/[.08] bg-white px-3.5 py-1.5 text-left text-[13px] text-zinc-700 transition hover:border-black/[.16] hover:bg-black/[.03] active:scale-[.98] dark:border-white/[.1] dark:bg-white/[.05] dark:text-zinc-300 dark:hover:bg-white/[.09]"
          >
            {phrase}
          </button>
        </li>
      ))}
    </ul>
  );
}
