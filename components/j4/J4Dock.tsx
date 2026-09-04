"use client";

import { useState } from "react";
import { J4Character, type J4State } from "./J4Character";
import { useJ4State } from "./useJ4State";
import type { TalkState } from "@/app/dashboard/useJ4Talk";
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
  talkState,
  onToggleTalk,
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
  /**
   * Talk Mode, moved here from the old centre orb.
   *
   * GENESIS_SURFACES: "Voice is available in every room. No exceptions."
   * The orb that used to carry it is gone, so the capability moves to J4's
   * own corner rather than disappearing with the thing that happened to
   * host it. This is his home; talking to him belongs in it.
   */
  talkState: TalkState;
  onToggleTalk: () => void;
}) {
  // SHARED WITH THE OFFICE. This rule used to live here alone; the Office
  // needed the same one, and two copies would have been two J4s having
  // different days on the same screen.
  const { state: activityState, justFocused } = useJ4State();

  // VOICE WINS WHEN VOICE IS HAPPENING. TalkState and J4State say the same
  // words - listening, thinking, speaking - and while the owner is actually
  // talking to him, the microphone is the truer account of what he is doing
  // than anything inferred from a text composer.
  const state = talkState === "off" ? activityState : (talkState as typeof activityState);
  const [expanded, setExpanded] = useState(false);
  const label = STATE_LABEL[state];

  return (
    <div
      data-testid="j4-dock"
      data-j4-expanded={expanded ? "true" : "false"}
      // EVERY WIDTH NOW. He used to be desktop-only because the mobile bar
      // had its own centre orb; that orb is gone, and one J4 identity
      // throughout the application means he cannot be absent on a phone.
      // Scaled down rather than redesigned - the mobile pass is its own
      // phase and this is not it.
      className="pointer-events-none fixed bottom-0 left-0 z-40 origin-bottom-left scale-[.68] sm:scale-[.8] lg:scale-100"
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

      {/* ---- J4'S CORNER, with his Office nested inside it -------------- */}
      {/*
          HIERARCHY, NOT ADJACENCY (2026-09-04, Sean). The first version put
          J4 and the Office side by side with a divider after them, which read
          as two buttons that happened to be neighbours. It is J4 -> Office,
          not J4 | Office.

          So the outer panel IS J4's permanent home, he fills it, and the
          Office is a small doorway set into its lower corner - a door in the
          wall of his room rather than a second occupant of the shelf. Talking
          to him is talking to him; the door is how you go further in.
      */}
      <div className="pointer-events-auto px-3 pb-3 pt-2">
        <div
          data-testid="j4-corner"
          className="relative rounded-[1.75rem] border border-[#4ade3a]/18 bg-[#050908]/55 p-2 pb-1 pr-[3.15rem] backdrop-blur-[2px]"
        >
          <button
            type="button"
            data-testid="j4-open"
            onClick={onOpen}
            aria-label={`J4 \u2014 ${label}. Open the conversation.`}
            className="block rounded-full transition-transform hover:scale-[1.03] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4ade3a]"
          >
            <J4Character
              state={state}
              gaze={justFocused ? "right" : "ahead"}
              size={124}
              title={`J4 \u2014 ${label}`}
            />
          </button>

          {/* THE DOORWAY. Deliberately small and set INTO his corner: a way
              through, not a peer. GENESIS_SURFACES has always said the Office
              is a room with a stable name, a place and a door - and this is
              the door, standing where the owner already looks for J4. */}
          <button
            type="button"
            data-testid="j4-office"
            onClick={onOpenOffice}
            aria-label="Office \u2014 the work you and J4 have done together"
            className="group absolute bottom-7 right-1.5 flex h-[2.9rem] w-[2.6rem] flex-col items-center justify-center gap-0.5 rounded-lg border border-[#4ade3a]/25 bg-[#050a08]/85 transition-colors hover:border-[#4ade3a]/55"
          >
            <svg
              viewBox="0 0 24 24"
              width="17"
              height="17"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.6}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-[#4ade3a]/80 transition-colors group-hover:text-[#4ade3a]"
              aria-hidden="true"
            >
              <path d="M7 21V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v16" />
              <path d="M4 21h16" />
              <circle cx="14" cy="13" r="0.9" fill="currentColor" stroke="none" />
            </svg>
            <span className="text-[8.5px] font-medium leading-none text-white/55 transition-colors group-hover:text-white/85">
              Office
            </span>
          </button>

          {/* TALK. Small, and beneath the door rather than beside the
              character, so the corner still reads as J4 first. */}
          <button
            type="button"
            data-testid="j4-talk-toggle"
            onClick={onToggleTalk}
            aria-pressed={talkState !== "off"}
            aria-label={talkState === "off" ? "Talk to J4" : `J4 is ${talkState}. Tap to stop.`}
            className={`absolute bottom-[3.9rem] right-1.5 flex h-[2.1rem] w-[2.6rem] items-center justify-center rounded-lg border transition-colors ${
              talkState === "off"
                ? "border-[#4ade3a]/25 bg-[#050a08]/85 text-[#4ade3a]/75 hover:border-[#4ade3a]/55 hover:text-[#4ade3a]"
                : "border-[#4ade3a]/70 bg-[#4ade3a]/15 text-[#4ade3a]"
            }`}
          >
            <svg
              viewBox="0 0 24 24"
              width="15"
              height="15"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              strokeLinecap="round"
              aria-hidden="true"
            >
              <rect x="9" y="3" width="6" height="11" rx="3" />
              <path d="M5 11a7 7 0 0 0 14 0" />
              <path d="M12 18v3" />
            </svg>
          </button>

          {/* THE EXPAND CONTROL IS EXPLICIT. The direction is specific that a
              double-tap must not be the primary discoverable interaction. */}
          <button
            type="button"
            data-testid="j4-expand"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
            className="mt-0.5 block w-full rounded-full px-2 py-0.5 text-center text-[11px] font-medium text-[#4ade3a]/80 transition-colors hover:text-[#4ade3a]"
          >
            {expanded ? "Minimise" : "Expand"}
          </button>
        </div>
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
