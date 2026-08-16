"use client";

import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { GenesisAvatar } from "./GenesisAvatar";
import { GENESIS_AVATAR_SIZE } from "@/lib/dashboard/genesisAvatarSize";
import type { TalkState } from "./useJ4Talk";

// J4's persistent presence: the orb, and Talk Mode (2026-08-14, third pass).
//
// Sean took this back to the original concept: "the goal is not to create a
// smaller text chat... Remove the placeholder text from the compact J4
// presence. Keep the orb. The orb is J4."
//
// So the compact surface is J4 himself and nothing else. The text field is
// gone — not moved, gone — because a field beside the orb made this a small
// chat box with a mascot attached, which is the thing that was drifting away
// from the point. Text is still available in the expanded conversation, for
// anyone who prefers it.
//
// TAPPING THE ORB STARTS A CONVERSATION, NOT A RECORDING. Sean, exactly:
// "This is NOT a voice memo interaction. It must NOT be tap → record → send."
// It is: tap → J4 listens → the owner speaks → J4 answers aloud → J4 listens
// again. See useJ4Talk.ts for the turn-taking. The microphone inside the
// expanded conversation stays what it always was, an explicit voice MESSAGE
// control, and the two must not be confused.
//
// Nothing here navigates, expands, or opens anything. The owner stays on the
// exact page they were on: "J4 shouldn't make the user go somewhere to talk to
// J4. J4 should be able to talk to them wherever they already are."
//
// WHY IT IS PORTALLED. The mobile nav carries backdrop-blur, and a
// backdrop-filter creates a stacking context that caps everything inside it at
// the nav's own z-index. Portalled to document.body there is no ancestor left
// whose stacking context, transform, filter or overflow could contain it.
// Above the tab bar (z-40) and the More menu (z-50), below the expanded
// conversation (z-60).

const J4_PRESENCE_Z = "z-[55]";

// "Are we on the client yet?", the SSR-safe way. A portal cannot render on the
// server, and reading `typeof document` during render would desync the trees.
const subscribeToNothing = () => () => {};
const onClient = () => true;
const onServer = () => false;

// What J4 is doing, in the owner's words rather than the state machine's.
const TALK_LABEL: Record<TalkState, string> = {
  off: "Talk to J4",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
};

export function J4Summon({
  open,
  onExpand,
  talkState,
  talkError,
  onToggleTalk,
}: {
  /** Whether the conversation is already expanded. */
  open: boolean;
  /** Pulls the conversation up. The handle, never the orb. */
  onExpand: () => void;
  talkState: TalkState;
  talkError: string | null;
  /** Starts or ends Talk Mode. The orb's only job. */
  onToggleTalk: () => void;
}) {
  const mounted = useSyncExternalStore(subscribeToNothing, onClient, onServer);
  if (!mounted) return null;

  const talking = talkState !== "off";

  return createPortal(
    // Fixed to the viewport, so scrolling can never move it or take its hit
    // area away. pointer-events-none on the wrapper so the space around the
    // orb never steals a tap meant for the page beneath.
    <div
      className={`pointer-events-none fixed inset-x-0 ${J4_PRESENCE_Z} flex flex-col items-center md:hidden`}
      // IN the tab bar band, not floating above it (2026-08-15).
      //
      // This sat 3.75rem up, which put it directly over the bottom of the
      // storefront preview — exactly where the owner needs to swipe to inspect
      // their own website. Sean: "J4 must never obstruct the website preview's
      // scroll surface." So the presence occupies navigation space alongside
      // the other tabs, and page content is never underneath it.
      style={{ bottom: "calc(env(safe-area-inset-bottom) + 1px)" }}
    >
      {talkError && (
        <p className="pointer-events-none mb-2 max-w-xs rounded-full bg-black/80 px-3 py-1.5 text-center text-[11px] text-white">
          {talkError}
        </p>
      )}

      {/* The state, said in a word. An orb that is listening has to say so in
          more than a colour, or the owner is guessing whether to speak. */}
      {talking && (
        <p className="pointer-events-none mb-2 rounded-full bg-[#2563eb] px-3 py-1 text-[12px] font-semibold text-white shadow-lg">
          {TALK_LABEL[talkState]}
        </p>
      )}

      <button
        type="button"
        onClick={onToggleTalk}
        aria-pressed={talking}
        aria-label={talking ? `J4: ${TALK_LABEL[talkState]}. Tap to stop.` : "Talk to J4"}
        className="pointer-events-auto relative -mt-9 rounded-full transition-transform duration-200 active:scale-95"
      >
        {/* Listening pulses outward; speaking glows steadily; thinking sits
            quiet. Subtle, but different enough to read at a glance without
            looking at the label. */}
        {/* Unmistakable, deliberately (2026-08-14). The active and resting
            glows previously differed only by a few pixels of inset and a
            little opacity, which read as no change at all on a phone — Sean
            tapped, the state really did change, and he could not see it. A
            state nobody can see is not a state. */}
        {talkState === "listening" && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -inset-3 animate-ping rounded-full bg-[#2563eb]/60"
            style={{ animationDuration: "1.4s" }}
          />
        )}
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute rounded-full transition-all duration-300 ${
            talking ? "-inset-4 bg-[#2563eb]/70 blur-lg" : "-inset-0 bg-transparent"
          }`}
        />
        {/* A hard ring as well as a glow, because a blur alone can vanish
            against a bright page. */}
        <GenesisAvatar
          className={`relative rounded-full transition-all duration-300 ${
            talking ? "ring-4 ring-[#2563eb] scale-110" : "ring-0"
          } ${GENESIS_AVATAR_SIZE.presenceOrb}`}
        />
      </button>

      {/* The way into the conversation, kept as its own control per Sean:
          "J4 presence = persistent interaction, Conversation = access to the
          conversation/history. Those don't need to occupy the same physical
          space." It reads as a tab label because it now sits in the tab bar,
          which is also what keeps it off the storefront's scroll surface. */}
      <button
        type="button"
        onClick={onExpand}
        aria-expanded={open}
        aria-label="Show the conversation"
        className="pointer-events-auto -mt-0.5 px-3 pb-1 text-[11px] font-medium text-zinc-500 dark:text-zinc-400"
      >
        Conversation
      </button>
    </div>,
    document.body
  );
}
