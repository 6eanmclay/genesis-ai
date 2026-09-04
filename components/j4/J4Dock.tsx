"use client";

import Link from "next/link";
import { useSyncExternalStore, useState, useEffect } from "react";
import { J4Character, type J4State } from "./J4Character";
import {
  getGenesisActivityServerSnapshot,
  getGenesisActivitySnapshot,
  subscribeGenesisActivity,
} from "@/lib/dashboard/genesisActivity";
import {
  getJ4FocusServerSnapshot,
  getJ4FocusSnapshot,
  subscribeJ4Focus,
} from "@/lib/dashboard/j4Focus";

// J4'S SEAT IN GENESIS (2026-09-03, first working version).
//
// The approved direction: a dedicated bottom-left zone, not a circle floating
// over the navigation. Compact means "I'm here"; expanded means "let's work
// together"; and expanding must not take Genesis away.
//
// DESKTOP ONLY, deliberately. The mobile bar puts J4 in its centre slot for a
// documented reason and the mobile pass is its own phase — this renders at lg:
// and above, where the shell's own comment says the desktop treatment "hasn't
// happened yet".
//
// NOT A MODAL. Expanded is a panel anchored to the same corner, with no overlay
// and no scroll lock, so the workspace and navigation stay usable and the owner
// can keep moving around Genesis while J4 is open. That is the whole difference
// between a partner and a chat widget.
//
// ONE J4, TWO PRESENTATIONS. This component owns no conversation, no
// understanding and no map state. It reads the activity and focus stores that
// already exist and renders a character; the conversation lives where it always
// has, on /j4. There is deliberately nothing here to keep in step with anything.

export function J4Dock({ conversationHref = "/j4" }: { conversationHref?: string }) {
  const activity = useSyncExternalStore(
    subscribeGenesisActivity,
    getGenesisActivitySnapshot,
    getGenesisActivityServerSnapshot,
  );
  const focus = useSyncExternalStore(
    subscribeJ4Focus,
    getJ4FocusSnapshot,
    getJ4FocusServerSnapshot,
  );

  const [expanded, setExpanded] = useState(false);

  // POINTING, FIRST VERSION. When J4 has focused something on the map — which
  // lives to the right of this corner — he looks that way. Simple controlled
  // motion rather than an animation system, which is what the direction asked
  // for at this stage: gestures that MEAN something before gestures that impress.
  const [justFocused, setJustFocused] = useState(false);
  // AN EVENT, NOT AN EFFECT. J4 pointing at something is a thing that
  // HAPPENS; reacting to it on every render would re-trigger the look
  // whenever anything else re-rendered this corner.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = subscribeJ4Focus(() => {
      if (getJ4FocusSnapshot().nodeIds.length === 0) return;
      setJustFocused(true);
      clearTimeout(timer);
      timer = setTimeout(() => setJustFocused(false), 2600);
    });
    return () => {
      clearTimeout(timer);
      stop();
    };
  }, []);

  const state: J4State = activity.isWorking
    ? "thinking"
    : activity.isComposing
      ? "listening"
      : justFocused
        ? "success"
        : "idle";

  const label = STATE_LABEL[state];

  return (
    <div
      data-testid="j4-dock"
      data-j4-expanded={expanded ? "true" : "false"}
      className="pointer-events-none fixed bottom-0 left-0 z-40 hidden lg:block"
    >
      {/* ---- EXPANDED: emerges from this corner, never the centre -------- */}
      {expanded && (
        <div
          data-testid="j4-expanded"
          className="pointer-events-auto absolute bottom-[7.5rem] left-4 w-[20rem] origin-bottom-left rounded-2xl border border-[#4ade3a]/30 bg-[#0b0f0e]/95 p-4 shadow-[0_18px_50px_-12px_rgba(0,0,0,.6)] backdrop-blur"
        >
          <p className="text-[13px] leading-snug text-white/85">
            {focus.nodeIds.length > 0
              ? "I've brought that up on your business map."
              : "I'm here. Ask me about your business, or tell me what to change."}
          </p>
          <Link
            href={conversationHref}
            className="mt-3 inline-flex items-center gap-2 rounded-full bg-[#4ade3a] px-4 py-2 text-[13px] font-medium text-[#06210a] transition-transform hover:scale-[1.03]"
          >
            Talk to J4
          </Link>
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="mt-3 ml-3 text-[12px] text-white/55 underline underline-offset-2 hover:text-white/80"
          >
            Minimise
          </button>
        </div>
      )}

      {/* ---- COMPACT: the seat itself ----------------------------------- */}
      <div className="pointer-events-auto flex w-[9.5rem] flex-col items-center gap-1 px-3 pb-3 pt-2">
        <Link
          href={conversationHref}
          aria-label={`J4 — ${label}. Open the conversation.`}
          className="rounded-full transition-transform hover:scale-[1.04] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4ade3a]"
        >
          <J4Character
            state={state}
            gaze={justFocused ? "right" : "ahead"}
            size={84}
            title={`J4 — ${label}`}
          />
        </Link>

        {/* THE EXPAND CONTROL IS EXPLICIT. The direction is specific that a
            double-tap must not be the primary discoverable interaction. */}
        <button
          type="button"
          data-testid="j4-expand"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className="rounded-full px-2 py-0.5 text-[11px] font-medium text-[#4ade3a]/85 transition-colors hover:text-[#4ade3a]"
        >
          {expanded ? "Minimise" : "Expand"}
        </button>
      </div>
    </div>
  );
}

// STATE IS SPOKEN TO ASSISTIVE TECHNOLOGY ONLY. The direction says J4
// communicates state through expression rather than a text label, so these
// never appear on screen — but "a green circle" is not a state to a screen
// reader, and the character carrying meaning is exactly why it needs saying.
const STATE_LABEL: Record<J4State, string> = {
  idle: "here",
  listening: "listening",
  thinking: "thinking",
  speaking: "speaking",
  success: "done",
  attention: "needs you",
};
