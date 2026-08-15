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
      className={`pointer-events-none fixed inset-x-0 ${J4_PRESENCE_Z} flex flex-col items-center px-3 md:hidden`}
      // Clears the tab bar rather than sitting on it.
      style={{ bottom: "calc(env(safe-area-inset-bottom) + 3.75rem)" }}
    >
      {talkError && (
        <p className="pointer-events-auto mb-2 max-w-xs rounded-full bg-black/80 px-3 py-1.5 text-center text-[11px] text-white">
          {talkError}
        </p>
      )}

      {/* The state, said in a word. An orb that is listening has to say so in
          more than a colour, or the owner is guessing whether to speak. */}
      {talking && (
        <p className="pointer-events-none mb-1.5 text-[11px] font-medium text-[#2563eb]">{TALK_LABEL[talkState]}</p>
      )}

      <button
        type="button"
        onClick={onToggleTalk}
        aria-pressed={talking}
        aria-label={talking ? `J4: ${TALK_LABEL[talkState]}. Tap to stop.` : "Talk to J4"}
        className="pointer-events-auto relative rounded-full transition-transform duration-200 active:scale-95"
      >
        {/* Listening pulses outward; speaking glows steadily; thinking sits
            quiet. Subtle, but different enough to read at a glance without
            looking at the label. */}
        {talkState === "listening" && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -inset-2 animate-ping rounded-full bg-[#2563eb]/40"
            style={{ animationDuration: "1.6s" }}
          />
        )}
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute rounded-full transition-all duration-300 ${
            talking ? "-inset-3 bg-[#2563eb]/35 blur-md" : "-inset-1 bg-[#2563eb]/20 blur-lg"
          }`}
        />
        <GenesisAvatar className={`relative ${GENESIS_AVATAR_SIZE.presenceOrb}`} />
      </button>

      {/* The way to the conversation, for reading it or for typing. Small and
          below J4, because it is the secondary path now. */}
      <button
        type="button"
        onClick={onExpand}
        aria-expanded={open}
        aria-label="Show the conversation"
        className="pointer-events-auto mt-1.5 rounded-full bg-white/90 px-3 py-1 text-[11px] font-medium text-zinc-600 shadow-sm backdrop-blur dark:bg-zinc-900/90 dark:text-zinc-300"
      >
        Conversation
      </button>
    </div>,
    document.body
  );
}
