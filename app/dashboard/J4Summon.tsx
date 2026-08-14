"use client";

import { useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { GenesisAvatar } from "./GenesisAvatar";
import { GENESIS_AVATAR_SIZE } from "@/lib/dashboard/genesisAvatarSize";
import { J4Icon } from "./J4Icon";

// J4's persistent presence: one continuous surface (2026-08-14).
//
// Sean's shape, exactly: "J4 presence → orb → compact composer, with the orb
// visually bridging the two." So this is a single panel, not a control
// floating above a field. The orb sits ON the seam between the presence strip
// and the composer, half in each, which is what makes the two read as one
// surface rather than two things stacked. It is also smaller than the old
// summon and backed by a ring in the panel's own colour, which is what closes
// the crack an unbacked overlap left around it.
//
// THE ORB DOES NOT EXPAND ANYTHING. Sean's correction, and the reason this
// stopped being a summon button: "tapping it should activate J4 HERE, not
// navigate or immediately turn into the pull-out/expanded conversation. The
// user should see and feel that J4 has been activated." So a tap wakes him —
// a visible pulse, an active ring, and the cursor placed in the field — and
// leaves the owner exactly where they are, with the compact composer still
// compact.
//
// EXPANSION IS ITS OWN AFFORDANCE. The grab handle pulls the conversation up.
// That is the only gesture that expands, apart from sending, which has to
// because a reply needs somewhere to be read. Compact is the default and
// expansion is secondary, which is the entire point of a presence rather than
// a panel.
//
// ONE COMPOSER, NOT TWO. This field does not send. It hands the text to the
// conversation's real composer, which owns the whole pipeline: optimistic
// messages, streaming, the slower fallback, voice, uploads, recovery. A second
// send path would be a second conversation, and it would silently miss every
// one of those behaviours. Compact and expanded are the same conversation with
// the same history; only the presentation differs.
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

export function J4Summon({
  open,
  onExpand,
  onSend,
}: {
  /** Whether the conversation is already expanded. */
  open: boolean;
  /** Pulls the conversation up. The handle and sending, never the orb. */
  onExpand: () => void;
  /** Hands typed text to the one real composer. This never sends. */
  onSend: (text: string) => void;
}) {
  const mounted = useSyncExternalStore(subscribeToNothing, onClient, onServer);
  const [draft, setDraft] = useState("");
  // J4 is awake and attending to this screen. Visible, and deliberately not
  // the same thing as the conversation being open.
  const [active, setActive] = useState(false);
  const fieldRef = useRef<HTMLInputElement>(null);

  if (!mounted) return null;

  return createPortal(
    // Fixed to the viewport, so scrolling can never move it or take its hit
    // area away. pointer-events-none on the wrapper so the padding around the
    // panel never steals a tap meant for the page beneath.
    <div
      className={`pointer-events-none fixed inset-x-0 ${J4_PRESENCE_Z} px-3 md:hidden`}
      // Clears the tab bar rather than sitting on it.
      style={{ bottom: "calc(env(safe-area-inset-bottom) + 3.75rem)" }}
    >
      <div className="pointer-events-auto mx-auto max-w-lg rounded-2xl border border-black/[.09] bg-white/95 shadow-lg backdrop-blur dark:border-white/[.145] dark:bg-zinc-950/95">
        {/* The pull. The only gesture besides sending that expands anything,
            and deliberately a separate target from the orb. */}
        <button
          type="button"
          onClick={onExpand}
          aria-expanded={open}
          aria-label="Show the conversation"
          className="flex w-full items-center justify-center rounded-t-2xl py-2 active:bg-black/[.03] dark:active:bg-white/[.05]"
        >
          <span className="h-1 w-9 rounded-full bg-black/[.15] dark:bg-white/[.2]" aria-hidden="true" />
        </button>

        <div className="flex items-end gap-2 px-3 pb-2">
          {/* The orb on the seam. -mt-7 lifts it by half its own height into
              the strip above, so it bridges the two areas rather than sitting
              on top of one. */}
          <button
            type="button"
            onClick={() => {
              setActive(true);
              // Wakes J4 and puts the cursor here. It does NOT expand: the
              // owner stays on this screen with the composer still compact,
              // which is the correction this behaviour exists for.
              fieldRef.current?.focus();
            }}
            aria-pressed={active}
            aria-label={active ? "J4 is active" : "Activate J4"}
            className="relative -mt-7 shrink-0 rounded-full transition-transform duration-200 active:scale-95"
          >
            {/* The active signal. A slow ring rather than a loud one: it has
                to be noticeable without becoming the brightest thing on a
                screen the owner is trying to read. */}
            {active && (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute -inset-1 animate-ping rounded-full bg-[#2563eb]/30"
                style={{ animationDuration: "2.2s" }}
              />
            )}
            <span
              aria-hidden="true"
              className={`pointer-events-none absolute -inset-0.5 rounded-full transition-colors duration-300 ${
                active ? "bg-[#2563eb]/25" : "bg-transparent"
              }`}
            />
            {/* The ring is the panel's own colour, so the circle joins the
                surface instead of leaving a visible crack where it overlaps. */}
            <GenesisAvatar
              className={`relative rounded-full ring-4 ring-white/95 dark:ring-zinc-950/95 ${GENESIS_AVATAR_SIZE.presenceOrb}`}
            />
          </button>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              const text = draft.trim();
              if (!text) return;
              setDraft("");
              // Sending expands, because a reply needs somewhere to be read.
              onSend(text);
            }}
            className="flex min-w-0 flex-1 items-center gap-2 pb-1"
          >
            <input
              ref={fieldRef}
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onFocus={() => setActive(true)}
              placeholder="Ask J4, or tell J4 what you're working on…"
              aria-label="Talk to J4"
              className="min-w-0 flex-1 bg-transparent py-1.5 text-[15px] text-black placeholder:text-zinc-400 focus:outline-none dark:text-zinc-50 dark:placeholder:text-zinc-500"
            />
            <button
              type="submit"
              disabled={!draft.trim()}
              aria-label="Send to J4"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#2563eb] text-white transition-opacity disabled:bg-transparent disabled:text-zinc-300 dark:disabled:text-zinc-600"
            >
              <J4Icon name="send" size={15} />
            </button>
          </form>
        </div>
      </div>
    </div>,
    document.body
  );
}
