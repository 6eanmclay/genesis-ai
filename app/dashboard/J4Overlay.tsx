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
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
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
    if (!open) return;
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
    if (!open) return;
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
      className={`fixed inset-0 z-[60] touch-none ${visible ? "" : "pointer-events-none"}`}
      role="dialog"
      aria-modal={visible}
      aria-hidden={!visible}
      aria-label="J4"
    >
      <button
        type="button"
        aria-label="Close J4"
        onClick={requestClose}
        tabIndex={visible ? 0 : -1}
        className={`absolute inset-0 bg-black/30 transition-opacity duration-300 md:bg-black/50 ${
          visible ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />

      {/* 68% on a phone, which is the figure the approved direction froze:
          "the composer is never a blank full-screen input... capped so the
          screen you summoned from stays visible." That cap is not decoration.
          It is the difference between talking to J4 about the thing in front
          of you and being taken somewhere to talk about it, and it is what
          makes "J4 comes to where I am" visible rather than merely true.
          Desktop is still edge to edge, and is wrong for the same reason, but
          desktop was explicitly held for its own design pass and inventing a
          layout for it here would be exactly the kind of decision that pass
          exists to make. */}
      <div
        className={`absolute inset-x-0 bottom-0 top-[32%] flex origin-bottom touch-auto flex-col overflow-hidden rounded-t-3xl bg-white shadow-2xl transition-[transform,opacity] duration-[380ms] dark:bg-zinc-950 md:top-0 md:rounded-none ${
          visible
            ? "translate-y-0 scale-100 opacity-100"
            : "pointer-events-none translate-y-8 scale-[0.96] opacity-0"
        }`}
        style={{ transitionTimingFunction: "cubic-bezier(0.32, 0.72, 0, 1)" }}
      >
        {/* The close row is NOT mobile only, though the grab handle in it is
            (2026-08-14). It was, briefly, and that was a real bug rather than
            a deferred desktop decision: on a wide viewport this panel is
            md:top-0, so it covers the backdrop that would otherwise dismiss
            it, and hiding the button left Escape as the only way out of J4.
            Desktop's composition is still held for its own pass; being able
            to close something is not composition. */}
        <div className="relative flex shrink-0 items-center justify-end px-3 pt-2">
          <span
            className="absolute left-1/2 top-2.5 h-1 w-9 -translate-x-1/2 rounded-full bg-black/[.15] dark:bg-white/[.2] md:hidden"
            aria-hidden="true"
          />
          {/* 44px, the platform minimum. The icon stays 20px; only the hit
              area grew, after a real report that the close control was hard
              to hit on a phone. */}
          <button
            type="button"
            onClick={requestClose}
            aria-label="Close J4"
            tabIndex={visible ? 0 : -1}
            className="-mr-1.5 flex h-11 w-11 items-center justify-center rounded-full text-zinc-500 active:bg-black/[.06] dark:text-zinc-400 dark:active:bg-white/[.08]"
          >
            <J4Icon name="close" size={20} />
          </button>
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
