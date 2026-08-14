"use client";

import { useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { GenesisAvatar } from "./GenesisAvatar";
import { GENESIS_AVATAR_SIZE } from "@/lib/dashboard/genesisAvatarSize";
import { J4Icon } from "./J4Icon";

// J4's presence: the composer IS the summon (2026-08-14).
//
// Sean's refinement, replacing a button that opened J4: "put the text composer
// directly above/around the J4 orb, with the orb visually overlapping the
// boundary so J4 feels present in the current surface. The user can type there
// if they don't want to talk."
//
// So J4 is not behind a door on every page — he is already on it, with
// somewhere to type. The owner who never wants to speak never has to, and the
// owner who never wants to type taps the orb. Both reach the same
// conversation, because they are input modes rather than different products.
//
// ONE COMPOSER, NOT TWO. This field does not send anything itself. It carries
// what was typed into the real conversation's composer, which owns the entire
// send pipeline: optimistic messages, streaming, fallback, voice, uploads,
// recovery. A second send path here would be a second conversation, which is
// the one thing this architecture rules out — and it would silently miss every
// hard-won behaviour that pipeline already has.
//
// WHY IT IS STILL PORTALLED. The mobile nav carries backdrop-blur, and a
// backdrop-filter creates a stacking context that caps everything inside it at
// the nav's own z-index. The presence has to sit above the nav and above page
// content, so it cannot live inside either. Portalled to document.body, there
// is no ancestor left whose stacking context, transform, filter or overflow
// could contain it.
//
// Z-ORDER: above the tab bar (z-40) and the More menu backdrop (z-50), below
// J4's own conversation (z-60). The only thing that may cover the presence is
// the conversation it opens.

const J4_PRESENCE_Z = "z-[55]";

// "Are we on the client yet?", the SSR-safe way. A portal cannot render on the
// server, and reading `typeof document` during render would desync the server
// and client trees.
const subscribeToNothing = () => () => {};
const onClient = () => true;
const onServer = () => false;

export function J4Summon({
  open,
  onSummon,
  onSend,
}: {
  /** Whether the conversation is already up. */
  open: boolean;
  /** Brings J4 here. Never navigates. */
  onSummon: () => void;
  /**
   * Hands typed text to the one real composer and opens the conversation.
   * This component never sends anything itself.
   */
  onSend: (text: string) => void;
}) {
  const mounted = useSyncExternalStore(subscribeToNothing, onClient, onServer);
  const [draft, setDraft] = useState("");

  if (!mounted) return null;

  const submit = () => {
    const text = draft.trim();
    if (!text) {
      // An empty send is a request for J4's attention, not a message.
      onSummon();
      return;
    }
    setDraft("");
    onSend(text);
  };

  return createPortal(
    // Fixed to the viewport, so scrolling can never move it, cover it, or take
    // its hit area away. The wrapper is pointer-events-none so the padding
    // around the controls never steals a tap meant for the page beneath.
    <div
      className={`pointer-events-none fixed inset-x-0 ${J4_PRESENCE_Z} px-3 md:hidden`}
      // Clears the tab bar rather than sitting on top of it. The bar is
      // ~56px of content plus the safe area, so the presence stacks directly
      // above it: nav at the bottom, then the field, then the orb breaking
      // the field's top edge.
      style={{ bottom: "calc(env(safe-area-inset-bottom) + 3.75rem)" }}
    >
      {/* The orb overlaps the field's top edge rather than sitting beside it,
          which is what makes J4 read as present in the page rather than as a
          control belonging to a toolbar. -mb-5 pulls the field up under him;
          the field's own left padding keeps text clear of the circle. */}
      <div className="pointer-events-auto relative mx-auto flex max-w-lg flex-col items-center">
        <button
          type="button"
          onClick={onSummon}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label="J4"
          className="relative z-10 -mb-5 flex items-center justify-center rounded-full p-1 transition-transform duration-200 active:scale-95"
        >
          {/* Halo, deliberately larger than the orb — J4's presence should
              extend past his own edge, which is what stops a circle from
              reading as a button and starts it reading as a light source.
              Blue, because only J4 is ever the light. */}
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -inset-2 rounded-full bg-[#2563eb]/25 blur-xl"
          />
          <GenesisAvatar className={`relative ${GENESIS_AVATAR_SIZE.summon}`} />
        </button>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="flex w-full items-center gap-2 rounded-2xl border border-black/[.09] bg-white/95 px-3 py-2 pt-6 shadow-lg backdrop-blur dark:border-white/[.145] dark:bg-zinc-950/95"
        >
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Ask J4, or tell J4 what you're working on…"
            aria-label="Talk to J4"
            className="min-w-0 flex-1 bg-transparent text-[15px] text-black placeholder:text-zinc-400 focus:outline-none dark:text-zinc-50 dark:placeholder:text-zinc-500"
          />
          <button
            type="submit"
            aria-label={draft.trim() ? "Send to J4" : "Open J4"}
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors ${
              draft.trim()
                ? "bg-[#2563eb] text-white"
                : "text-zinc-400 dark:text-zinc-500"
            }`}
          >
            <J4Icon name={draft.trim() ? "send" : "add"} size={16} />
          </button>
        </form>
      </div>
    </div>,
    document.body
  );
}
