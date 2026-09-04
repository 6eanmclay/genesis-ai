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
  presentation = "office",
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  /**
   * HOW the same conversation is shown (2026-09-03).
   *
   * "office" is unchanged and still means what the comment below its panel
   * says it means: a full screen you have entered, frozen deliberately in
   * 2026-08-15. Reaching the Office through its own navigation still does
   * exactly that.
   *
   * "panel" is J4 opening HIMSELF up from the corner instead. Non-modal, no
   * scrim, no scroll lock: the workspace stays visible, clickable and
   * scrollable, which is what the approved direction requires of the
   * expanded character.
   *
   * ONE MOUNT, TWO PRESENTATIONS. The children are the same element either
   * way, so the conversation and its state are literally the same instance -
   * switching how it is framed cannot restart it, and there is no second
   * chat to keep in step.
   */
  presentation?: "office" | "panel";
}) {
  const isPanel = presentation === "panel";
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
    // THE PANEL MUST NOT FREEZE THE PAGE. Locking the body is right for a
    // full screen you have entered and wrong for a partner sitting in the
    // corner: the owner has to be able to scroll the map they are asking
    // about while asking about it.
    if (!open || isPanel) return;
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
  }, [open, isPanel]);

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
      className={
        isPanel
          ? // ANCHORED TO HIS CORNER, and sized to leave the workspace
            // visible beside it. No inset-0, so nothing covers the page.
            `fixed bottom-[10.5rem] left-4 z-[60] w-[min(26rem,calc(100vw-2rem))] ${
              visible ? "" : "pointer-events-none"
            }`
          : `fixed inset-0 z-[60] touch-none ${visible ? "" : "pointer-events-none"}`
      }
      role="dialog"
      // NOT MODAL as a panel. aria-modal would tell a screen reader the rest
      // of the page is inert, which is the opposite of the point.
      aria-modal={isPanel ? undefined : visible}
      aria-hidden={!visible}
      aria-label={isPanel ? "J4" : "J4's Office"}
      data-j4-presentation={presentation}
    >
      {/* Kept even though the Office now covers it. It is what the panel
          animates in over, so removing it would show the workspace sliding
          about behind a translucent edge for the length of the transition. */}
      {/* The scrim belongs to the Office. A panel that dimmed the workspace
          would be a modal wearing a smaller shape. */}
      {!isPanel && (
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
          isPanel
            ? // EMERGING FROM HIS CORNER: the origin is bottom-left, so it
              // grows out of J4 rather than appearing over the page.
              `flex max-h-[min(34rem,70vh)] origin-bottom-left touch-auto flex-col overflow-hidden rounded-2xl border border-[#4ade3a]/25 bg-white shadow-[0_24px_60px_-20px_rgba(0,0,0,.65)] transition-[transform,opacity] duration-[380ms] dark:bg-zinc-950 ${
                visible
                  ? "translate-y-0 scale-100 opacity-100"
                  : "pointer-events-none translate-y-4 scale-[0.96] opacity-0"
              }`
            : `absolute inset-0 flex origin-bottom touch-auto flex-col overflow-hidden bg-white shadow-2xl transition-[transform,opacity] duration-[380ms] dark:bg-zinc-950 ${
                visible
                  ? "translate-y-0 scale-100 opacity-100"
                  : "pointer-events-none translate-y-8 scale-[0.96] opacity-0"
              }`
        }
        style={{ transitionTimingFunction: "cubic-bezier(0.32, 0.72, 0, 1)" }}
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
          style={{ paddingTop: "calc(env(safe-area-inset-top) + 0.5rem)" }}
        >
          <span className="pl-1.5 text-[15px] font-semibold text-black dark:text-zinc-50">
            Office
          </span>
          {/* 44px, the platform minimum. The icon stays 20px; only the hit
              area grew, after a real report that the close control was hard
              to hit on a phone. */}
          <button
            type="button"
            onClick={requestClose}
            aria-label="Leave the Office"
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
