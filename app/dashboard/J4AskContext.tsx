"use client";

import { createContext, useContext } from "react";

// How a page asks J4 for something (2026-08-17).
//
// Studio's recommendation chips need to put a real request into the real
// conversation. They must not send it themselves: the conversation's composer
// owns the entire send pipeline — optimistic messages, streaming, the slower
// fallback, failure recovery — and a second send path would be a second
// conversation that silently misses all of it. That is the same reasoning
// J4HandoffContext already records.
//
// So this hands the text to the existing handoff and opens the conversation,
// which is exactly what the presence field does. One pipeline, one history,
// reached from one more place.
//
// A SEPARATE CONTEXT from J4HandoffContext for a structural reason, not a
// stylistic one: that provider sits INSIDE J4Overlay, so page content cannot
// reach it. This one wraps `children`.

export interface J4Ask {
  /** Sends a message to J4 and opens the conversation. */
  ask: (text: string) => void;
  /** False when no provider is present, so a caller can render nothing rather than a dead control. */
  available: boolean;
}

export const J4AskContext = createContext<J4Ask>({
  ask: () => {},
  available: false,
});

export function useJ4Ask(): J4Ask {
  return useContext(J4AskContext);
}
