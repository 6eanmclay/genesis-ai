"use client";

import { createContext } from "react";

// The one-way handoff from the persistent presence to the one composer
// (2026-08-14).
//
// The owner can type into J4's presence without opening anything, but that
// field does not send. It hands the text to the conversation's real composer,
// which owns the entire send pipeline — optimistic messages, streaming, the
// slower fallback, voice, uploads, failure recovery. A second send path would
// be a second conversation, and it would silently miss every one of those
// behaviours.
//
// Context rather than a prop because the conversation is a SERVER component
// handed down through app/dashboard/layout.tsx. Props cannot cross that
// boundary from a client parent, but a client context provider wrapping
// server-rendered children can be read by client components inside them.
//
// `clear` is not optional politeness. Without it the same text would be resent
// every time the conversation remounted or re-rendered, so the consumer must
// take the value exactly once.
export interface J4Handoff {
  text: string | null;
  clear: () => void;
}

export const J4HandoffContext = createContext<J4Handoff>({ text: null, clear: () => {} });
