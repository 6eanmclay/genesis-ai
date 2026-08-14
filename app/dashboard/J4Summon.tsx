"use client";

import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { GenesisAvatar } from "./GenesisAvatar";
import { GENESIS_AVATAR_SIZE } from "@/lib/dashboard/genesisAvatarSize";

// The summon, as its own topmost layer (2026-08-14).
//
// Sean's correction, and the test he made non-negotiable: "if tapping the J4
// summon causes the owner to leave the page they're currently working on, the
// implementation is wrong." That part was already true — it sets state and
// nothing navigates. This file fixes the other half of the same instruction:
// "make that entire bottom-center J4 control a topmost interaction layer...
// never gets covered by another element... scrolling the page must never
// affect its ability to be tapped."
//
// WHY IT HAD TO LEAVE THE TAB BAR. The control used to live inside the mobile
// <nav>, lifted above the bar's top edge with a negative margin. That looked
// right and was structurally wrong, because the nav carries `backdrop-blur`,
// and a backdrop-filter creates a stacking context. Everything inside it is
// therefore trapped at the nav's own z-40 no matter what z-index the button
// itself is given. The lifted upper half of the orb — most of its hit area —
// overlapped page content that any higher-stacked element could cover, and
// the More menu's own z-50 backdrop covered the whole thing outright.
//
// Portalled to document.body for the same reason J4Overlay is: it is the only
// way to guarantee no ancestor's stacking context, transform, filter or
// overflow can ever contain it. This is not defensive styling that a future
// change could quietly undo. There is no ancestor left to interfere.
//
// Z-ORDER, deliberately: above the tab bar (z-40) and above the More menu
// backdrop (z-50), below J4 himself (z-60). The only thing that may cover the
// summon is the conversation it opens.

const J4_SUMMON_Z = "z-[55]";

// "Are we on the client yet?", the SSR-safe way. A portal cannot render on
// the server, and reading `typeof document` during render would desync the
// server and client trees. useSyncExternalStore answers false on the server
// and true in the browser without setting state in an effect, which is both
// the idiomatic form and the one that does not trip react-hooks/set-state-
// in-effect. The store never changes, so the subscribe callback is inert.
const subscribeToNothing = () => () => {};
const onClient = () => true;
const onServer = () => false;

export function J4Summon({
  open,
  onSummon,
}: {
  /** Whether the J4 layer is already up. */
  open: boolean;
  /** Brings J4 here. Never navigates. */
  onSummon: () => void;
}) {
  const mounted = useSyncExternalStore(subscribeToNothing, onClient, onServer);
  if (!mounted) return null;

  return createPortal(
    // Fixed to the viewport, so scrolling cannot move it, cover it, or take
    // its hit area away. The wrapper is pointer-events-none so that the
    // padding around the orb never steals a tap meant for the page beneath;
    // only the control itself is interactive.
    <div
      className={`pointer-events-none fixed inset-x-0 ${J4_SUMMON_Z} flex justify-center md:hidden`}
      style={{ bottom: "calc(env(safe-area-inset-bottom) + 2px)" }}
    >
      <button
        type="button"
        onClick={onSummon}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="J4"
        // p-2 grows the hit area past the 88px orb in every direction without
        // changing what is drawn, so the edge of the circle is comfortably
        // tappable rather than exactly tappable.
        className="pointer-events-auto relative flex items-center justify-center rounded-full p-2 transition-transform duration-200 active:scale-95"
      >
        {/* Halo, deliberately larger than the orb — J4's presence should
            extend past his own edge, which is also what stops an 88px circle
            from reading as a button and starts it reading as a light source.
            Blue, because only J4 is ever the light. */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -inset-2 rounded-full bg-[#2563eb]/25 blur-xl"
        />
        <GenesisAvatar className={`relative ${GENESIS_AVATAR_SIZE.summon}`} />
      </button>
    </div>,
    document.body
  );
}
