"use client";

import { useState } from "react";
import { J4Character, type J4State } from "./J4Character";
import { useJ4State } from "./useJ4State";
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

export function J4Dock({
  onOpen,
  onOpenOffice,
}: {
  /**
   * Open the conversation J4 already has.
   *
   * THE DOCK IS AN ENTRY POINT, NOT A CHAT. The shell already owns the real
   * surface - the same one the orb opened - so this asks for it rather than
   * building a second one. A dock with its own chat would be a decorative
   * character sitting beside a chatbot, which is the thing this is meant to
   * stop being.
   *
   * It also means the conversation cannot be destroyed by expanding or
   * minimising: this component owns none of it.
   */
  onOpen: () => void;
  /**
   * Open the Office - the established full-screen surface, unchanged.
   *
   * THE PAIR (2026-09-04, Sean): J4 and the Office are two ways into the same
   * partnership, not two assistants. J4 is talk to my business partner; the
   * Office is work with my business partner. They sit together in this corner
   * and a divider separates them from the business destinations, which are
   * navigation rather than partnership.
   *
   * This asks the shell for the presentation it already has. The Office is not
   * reimplemented, not made non-modal, and not given a second conversation -
   * the overlay it opens is the same element this dock's own panel opens, in
   * its other presentation.
   */
  onOpenOffice: () => void;
}) {
  // SHARED WITH THE OFFICE. This rule used to live here alone; the Office
  // needed the same one, and two copies would have been two J4s having
  // different days on the same screen.
  const { state, justFocused } = useJ4State();
  const [expanded, setExpanded] = useState(false);
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
            {justFocused
              ? "I've brought that up on your business map."
              : "I'm here. Ask me about your business, or tell me what to change."}
          </p>
          <button
            type="button"
            data-testid="j4-talk"
            onClick={onOpen}
            className="mt-3 inline-flex items-center gap-2 rounded-full bg-[#4ade3a] px-4 py-2 text-[13px] font-medium text-[#06210a] transition-transform hover:scale-[1.03]"
          >
            Talk to J4
          </button>
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="mt-3 ml-3 text-[12px] text-white/55 underline underline-offset-2 hover:text-white/80"
          >
            Minimise
          </button>
        </div>
      )}

      {/* ---- COMPACT: J4 and his Office, as one unit -------------------- */}
      {/*
          LAYOUT CONCEPT ONLY at this stage. Sean asked for the physical
          relationship first - [J4][Office] | [business] - and said he would
          critique the visual treatment after seeing it running. So this is
          grouping and spacing over the existing behaviour: no new J4 system,
          no change to what either control opens.
      */}
      <div className="pointer-events-auto flex items-end gap-2 px-3 pb-3 pt-2">
        <div
          data-testid="j4-pair"
          className="flex items-end gap-1 rounded-2xl border border-[#4ade3a]/15 bg-[#070b0a]/45 p-1 pr-1.5 backdrop-blur-[2px]"
        >
        <div className="flex w-[9.5rem] flex-col items-center gap-1">
        <button
          type="button"
          data-testid="j4-open"
          onClick={onOpen}
          aria-label={`J4 — ${label}. Open the conversation.`}
          className="rounded-full transition-transform hover:scale-[1.04] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4ade3a]"
        >
          <J4Character
            state={state}
            gaze={justFocused ? "right" : "ahead"}
            size={116}
            title={`J4 — ${label}`}
          />
        </button>

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

          {/* ---- THE OFFICE, beside him ------------------------------- */}
          {/* A PLACE, NOT A SECOND ASSISTANT. GENESIS_SURFACES is explicit
              that the Office is still a room with a stable name, a place and
              a door - it is simply not a tab in the room bar. This is that
              door, put where the owner already looks for J4, which is why it
              is drawn as somewhere to go rather than as a face to talk to. */}
          <button
            type="button"
            data-testid="j4-office"
            onClick={onOpenOffice}
            aria-label="Office - the work you and J4 have done together"
            className="group mb-[1.375rem] flex h-[6.25rem] w-[5.25rem] flex-col items-center justify-center gap-2 rounded-xl border border-[#4ade3a]/20 bg-[#0b1210]/70 transition-colors hover:border-[#4ade3a]/45 hover:bg-[#0e1a16]/85 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4ade3a]"
          >
            <svg
              viewBox="0 0 24 24"
              width="26"
              height="26"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-[#4ade3a]/75 transition-colors group-hover:text-[#4ade3a]"
              aria-hidden="true"
            >
              <path d="M7 21V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v16" />
              <path d="M4 21h16" />
              <circle cx="14" cy="13" r="0.9" fill="currentColor" stroke="none" />
            </svg>
            <span className="text-[11px] font-medium text-white/65 transition-colors group-hover:text-white/90">
              Office
            </span>
          </button>
        </div>

        {/* THE DIVIDER. Everything left of it is the partnership; everything
            right of it is the business. The whole point of the grouping is
            that J4 and the Office stop reading as two competing assistants. */}
        <div
          data-testid="j4-dock-divider"
          aria-hidden="true"
          className="mb-8 h-14 w-px bg-gradient-to-b from-transparent via-white/20 to-transparent"
        />
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
