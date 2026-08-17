"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { J4Icon } from "./J4Icon";

// J4 as a persistent layer, not a destination (2026-08-14).
//
// Sean's correction, and the reason this file replaces an intercepting route:
// "J4 is not a destination or a separate page that the user navigates into
// and out of. J4 is a persistent intelligence layer within the business
// workspace." The owner looks at something, summons J4, asks about it, closes
// the conversation, keeps scrolling, and summons him again — never leaving
// the workspace and never losing their place.
//
// WHY THE ROUTE HAD TO GO. The previous version opened /j4 through a parallel
// and intercepting route. Four bugs came out of that, and every one of them
// was routing being routing rather than a flaw in the sheet: the App Router
// scrolled the workspace to top on navigation; closing pushed history, so a
// double tap popped two entries; leaving by the back gesture unmounted the
// sheet with an exit timer still pending, which then navigated the page out
// from under the owner; and the workspace unmounted and remounted around it.
// Patching those individually was treating symptoms of a category error.
// Nothing here navigates, so that entire class of bug is gone by
// construction rather than by defence.
//
// WHAT STAYS MOUNTED. `children` is J4's real server-rendered workspace,
// handed down from app/dashboard/layout.tsx and mounted for the life of the
// dashboard. It is hidden rather than unmounted when closed, so an in-flight
// conversation survives being closed and reopened — which is the difference
// between a partner who is already there and an app you revisit.

export function J4Overlay({
  open,
  onClose,
  children,
  mode = "overlay",
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  /**
   * How the one conversation is presented (2026-08-18).
   *
   * "overlay" is the Office: full screen, modal, entered on purpose.
   * "docked" is Studio: a panel beneath the bench, always there, not modal —
   * the creative session lives in the room the owner is working in.
   *
   * ONE INSTANCE, TWO PRESENTATIONS, and that is the whole point. Rendering
   * the conversation in a second place would create a second J4Workspace with
   * its own composer and its own message list — a second conversation arrived
   * at by accident. So this component moves nothing; it changes how the single
   * mounted conversation is framed.
   */
  mode?: "overlay" | "docked";
}) {
  const docked = mode === "docked";
  // The animation's own state, which is not the same thing as `open`. It
  // trails `open` by one frame on the way in: the panel mounts in its closed
  // position and only then transitions, because an element that mounts
  // already in its final position has nothing to animate from. On the way out
  // it follows `open` down immediately, and the panel animates out from a
  // layer that is still mounted.
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      setVisible(true);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      // The exit, wherever the close came from. `open` is the single source
      // of truth for whether J4 is up; the panel's visual state can never
      // disagree with it because it is derived from it, not sequenced
      // alongside it.
      setVisible(false);
    };
  }, [open]);

  // Close is one move. An earlier version delayed onClose by the length of
  // the exit animation so the sheet could finish before the parent flipped
  // its state — which was unnecessary (the layer stays mounted either way)
  // and bought a real bug: close, then summon again inside that window, and
  // the pending timer slammed J4 shut on an owner who had just reopened him.
  // Telling the parent immediately makes reopening mid-exit simply work.
  const requestClose = useCallback(() => {
    onClose();
  }, [onClose]);

  // Scroll lock, only while J4 is actually over the workspace.
  //
  // The technique is the one GenesisAssistant.tsx already proved and
  // documented: plain overflow:hidden is unreliable on iOS Safari, which
  // rubber-band scrolls straight through it, so the body is pinned at its own
  // negative scroll offset and the exact offset is put back on close. Every
  // property is captured before being overwritten and restored individually,
  // so this coexists with any other lock rather than clobbering it.
  //
  // Because nothing navigates now, the workspace underneath never unmounts
  // and its scroll position is never touched by anything but this — which is
  // what makes "close J4 and you are exactly where you were" structural.
  useEffect(() => {
    // Overlay only. Pinning the body in docked mode would freeze the Studio
    // bench the panel is supposed to sit beneath — the conversation is not
    // modal there, so nothing behind it should be immobilised.
    if (!open || docked) return;
    const scrollY = window.scrollY;
    const previous = {
      position: document.body.style.position,
      top: document.body.style.top,
      left: document.body.style.left,
      right: document.body.style.right,
      width: document.body.style.width,
      overflow: document.body.style.overflow,
    };
    document.body.style.position = "fixed";
    document.body.style.top = `-${scrollY}px`;
    document.body.style.left = "0";
    document.body.style.right = "0";
    // Required alongside position: fixed — without it the body collapses to
    // its content width the moment it leaves normal flow.
    document.body.style.width = "100%";
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.position = previous.position;
      document.body.style.top = previous.top;
      document.body.style.left = previous.left;
      document.body.style.right = previous.right;
      document.body.style.width = previous.width;
      document.body.style.overflow = previous.overflow;
      window.scrollTo(0, scrollY);
    };
  }, [open]);

  useEffect(() => {
    // Escape closes the Office. In Studio there is nothing to close to.
    if (!open || docked) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") requestClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, requestClose]);

  // Mounted from the first render, not from the first open (2026-08-14).
  //
  // This used to return null until the conversation had been expanded once, so
  // the workspace paid no DOM cost for a layer the owner had not used. Talk
  // Mode broke that assumption completely: it sends a spoken turn through the
  // conversation's own composer WITHOUT expanding anything, so on a page where
  // J4 had never been opened there was no composer to send through. The turn
  // went nowhere, no reply ever came back, and the orb sat on "Thinking"
  // forever — which is exactly what Sean hit on the first real voice test.
  //
  // The conversation is therefore always mounted and merely hidden. That is
  // the real cost of a partner who can be spoken to without being opened, and
  // it is the whole feature rather than an oversight.
  if (typeof document === "undefined") return null;

  return createPortal(
    // touch-none stops browser gesture handling (pull to refresh, rubber
    // banding) reaching the workspace underneath; the panel re-enables it for
    // its own content below. pointer-events-none while closed means the
    // hidden layer can never intercept a tap meant for the workspace, which
    // is what made the page feel frozen around the control.
    <div
      className={
        docked
          ? // Above the nav (z-40), below the orb (z-55) so the presence still
            // reads as the topmost thing. Ends above the tab bar band rather
            // than behind it.
            // Not mobile-only: on a wide viewport the Studio chips would otherwise
            // set a handoff with nothing on screen to receive it, which is a
            // dead control. Desktop keeps its own Office door as well.
            "pointer-events-none fixed inset-x-0 bottom-[6.75rem] z-[45] h-[42vh] px-3 md:bottom-6 md:left-auto md:right-6 md:h-[60vh] md:w-[26rem] md:px-0"
          : `fixed inset-0 z-[60] touch-none ${visible ? "" : "pointer-events-none"}`
      }
      role={docked ? "region" : "dialog"}
      aria-modal={docked ? undefined : visible}
      aria-hidden={docked ? undefined : !visible}
      aria-label={docked ? "Your session with J4" : "J4's Office"}
    >
      {/* Kept even though the Office now covers it. It is what the panel
          animates in over, so removing it would show the workspace sliding
          about behind a translucent edge for the length of the transition. */}
      {!docked && (
        <div
          aria-hidden="true"
          className={`absolute inset-0 bg-black/30 transition-opacity duration-300 md:bg-black/50 ${
            visible ? "opacity-100" : "pointer-events-none opacity-0"
          }`}
        />
      )}

      {/* FULL SCREEN. This is the Office, and entering it is the point.
          Sean, 2026-08-15: "don't open it as a half-height sheet, drawer, or
          partial overlay... It should feel like I've actually entered that
          workspace."

          WHY THE 68% CAP IS GONE, since it was frozen deliberately and its
          reasoning was good. The cap existed because this panel used to be the
          COMPOSER — "capped so the screen you summoned from stays visible,"
          which was the difference between talking to J4 about the thing in
          front of you and being taken somewhere to talk about it.

          That job moved. Talking to J4 about what is in front of you is Talk
          Mode now: tap the orb, speak, and this panel never opens at all. The
          principle the cap was protecting is better served by the thing that
          replaced it, and holding a sheet at 68% would now only mean the
          Office can never look like a room.

          So the two are cleanly split. The orb brings J4 to where the owner
          is. This brings the owner to where the work is. */}
      <div
        className={
          docked
            ? "pointer-events-auto flex h-full touch-auto flex-col overflow-hidden rounded-2xl border border-black/[.08] bg-white shadow-[0_-2px_24px_-8px_rgba(0,0,0,.22)] dark:border-white/[.1] dark:bg-zinc-950"
            : `absolute inset-0 flex origin-bottom touch-auto flex-col overflow-hidden bg-white shadow-2xl transition-[transform,opacity] duration-[380ms] dark:bg-zinc-950 ${
                visible
                  ? "translate-y-0 scale-100 opacity-100"
                  : "pointer-events-none translate-y-8 scale-[0.96] opacity-0"
              }`
        }
        style={docked ? undefined : { transitionTimingFunction: "cubic-bezier(0.32, 0.72, 0, 1)" }}
      >
        {/* The close row is NOT mobile only, though the grab handle in it is
            (2026-08-14). It was, briefly, and that was a real bug rather than
            a deferred desktop decision: on a wide viewport this panel is
            md:top-0, so it covers the backdrop that would otherwise dismiss
            it, and hiding the button left Escape as the only way out of J4.
            Desktop's composition is still held for its own pass; being able
            to close something is not composition. */}
        {/* The grab handle is gone with the sheet it belonged to. A pill at
            the top edge is the universal sign for "drag me down," and on a
            surface that no longer behaves like a sheet it would be promising a
            gesture that does nothing. What is left names the room, so entering
            it is unambiguous. Safe-area padding because this now reaches the
            top of the screen and would otherwise sit under the notch. */}
        <div
          className="relative flex shrink-0 items-center justify-between px-3 pt-2"
          style={docked ? { paddingTop: "0.5rem" } : { paddingTop: "calc(env(safe-area-inset-top) + 0.5rem)" }}
        >
          <span className="pl-1.5 text-[15px] font-semibold text-black dark:text-zinc-50">
            {/* Named for the room it is in. In Studio this is the creative
                session, not a visit to the Office — Office still records every
                message, because it is literally the same conversation. */}
            {docked ? "Working with J4" : "Office"}
          </span>
          {/* 44px, the platform minimum. The icon stays 20px; only the hit
              area grew, after a real report that the close control was hard
              to hit on a phone. */}
          {/* No close control when docked: the session belongs to the room,
              and there is nowhere to close it to. */}
          {!docked && (
            <button
              type="button"
              onClick={requestClose}
              aria-label="Leave the Office"
              tabIndex={visible ? 0 : -1}
              className="-mr-1.5 flex h-11 w-11 items-center justify-center rounded-full text-zinc-500 active:bg-black/[.06] dark:text-zinc-400 dark:active:bg-white/[.08]"
            >
              <J4Icon name="close" size={20} />
            </button>
          )}
        </div>

        {/* Deliberately not scrollable. The conversation inside manages its
            own scrolling (and its own overscroll-contain, which is what stops
            a scroll reaching the end of the messages from chaining into the
            workspace underneath). A second scroll container wrapped around
            one is the classic phone failure where a drag moves the sheet
            instead of the messages, and it can only ever fight the one that
            actually holds the content. */}
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      </div>
    </div>,
    document.body
  );
}
