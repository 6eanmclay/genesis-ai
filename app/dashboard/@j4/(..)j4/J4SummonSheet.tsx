"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { J4Icon } from "@/app/dashboard/J4Icon";

// "Are we past hydration?" without a setState-in-effect (which cascades a
// render and is a real lint error here). Same useSyncExternalStore idiom
// GenesisAssistant.tsx already uses. Nothing ever changes, so the subscribe
// callback is a no-op — the server snapshot is false, the client's is true,
// and that difference is the entire signal.
const subscribeToNothing = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

// Slightly shorter than the 380ms entrance — leaving should feel quicker than
// arriving, and waiting the full duration before navigating reads as lag.
const EXIT_MS = 240;

// The summoned J4 layer (2026-08-12). J4 comes to where the owner is rather
// than the owner leaving their business to go find J4 — Sean's own framing,
// and the reason the center control is a summon and not a destination.
//
// Portals to document.body deliberately. This renders inside <main>, and this
// shell already has one real production bug on record from exactly that
// (DashboardShell's desktop "More" panel rendered completely invisible
// because an ancestor carried lg:overflow-hidden). A fixed element inside a
// clipped ancestor is a bug waiting for a viewport; portaling is the fix that
// file already landed on, reused rather than rediscovered.
//
// Dismissal is router.back(), never a local "closed" flag — the URL really is
// /j4 while this is open, so backwards navigation is the honest way to leave
// and it keeps the browser's own back gesture doing the obvious thing.
export function J4SummonSheet({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const mounted = useSyncExternalStore(subscribeToNothing, clientSnapshot, serverSnapshot);
  // Drives the enter transition. Starting false and flipping on the next
  // frame is what gives the sheet something to animate FROM; rendering it
  // already-open would just pop into place. Set inside a rAF callback, not
  // in the effect body — the callback is exactly the escape hatch the
  // no-setState-in-effect rule leaves open.
  const [shown, setShown] = useState(false);
  const dismissedRef = useRef(false);
  const exitTimer = useRef<number | null>(null);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // Dismissal has to animate too. router.back() on its own unmounts this
  // instantly, so J4 grew smoothly out of the control and then vanished — an
  // asymmetry you feel even if you can't name it. Reverse the entrance, then
  // navigate once it has actually played.
  // Guarded, 2026-08-12. Two real ways this misfired before.
  //
  // Unguarded, a second tap (or Escape while the exit was already playing)
  // queued a second router.back(), popping two history entries and landing
  // the owner somewhere they never asked to be. dismissedRef makes the first
  // dismissal the only one.
  //
  // And if the owner leaves by the browser's own back gesture, this component
  // unmounts while the timer is still pending; without the cleanup below,
  // that timer still fired router.back() afterwards and navigated the page
  // out from under them. That is the second half of the "it navigates away"
  // report.
  const dismiss = useCallback(() => {
    if (dismissedRef.current) return;
    dismissedRef.current = true;
    setShown(false);
    exitTimer.current = window.setTimeout(() => router.back(), EXIT_MS);
  }, [router]);

  useEffect(
    () => () => {
      if (exitTimer.current !== null) window.clearTimeout(exitTimer.current);
    },
    []
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    document.addEventListener("keydown", onKey);

    // Scroll lock, corrected 2026-08-12 after a real device report: opening
    // J4 and closing it left the page underneath frozen around the floating
    // control.
    //
    // The original version here set only `overflow: hidden` on <body>, which
    // is exactly the approach GenesisAssistant.tsx's own comment already
    // documents as broken — plain overflow:hidden is unreliable on iOS
    // Safari, which still rubber-band scrolls under it. Worse, it never
    // captured the scroll offset, so there was nothing to restore and the
    // workspace came back wherever the browser happened to leave it.
    //
    // This is the technique that file already proved: pin the body at its own
    // negative scroll offset, which genuinely stops every engine, then put
    // the exact offset back on close so the workspace returns to the pixel
    // the owner summoned J4 from. Every property is captured before being
    // overwritten and restored individually, so this coexists with any other
    // lock instead of clobbering it.
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
    // width: 100% is required alongside position: fixed — without it the body
    // collapses to its content width the instant it leaves normal flow.
    document.body.style.width = "100%";
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.position = previous.position;
      document.body.style.top = previous.top;
      document.body.style.left = previous.left;
      document.body.style.right = previous.right;
      document.body.style.width = previous.width;
      document.body.style.overflow = previous.overflow;
      // Restoring the styles alone leaves the page at the top. This line is
      // what actually returns the owner to where they were.
      window.scrollTo(0, scrollY);
    };
  }, [dismiss]);

  if (!mounted) return null;

  return createPortal(
    // touch-none on the container stops browser gesture handling (pull to
    // refresh, rubber banding) from reaching the page underneath; the sheet's
    // own scroll area re-enables it for itself below.
    <div className="fixed inset-0 z-[60] touch-none" role="dialog" aria-modal="true" aria-label="J4">
      {/* Mobile keeps a strip of the owner's own screen visible above the
          sheet — that strip is the whole point, it's what says "you are still
          where you were." At md:+ this covers fully, matching the dedicated
          full-screen treatment /j4 already had, so desktop is unchanged. */}
      <button
        type="button"
        aria-label="Close J4"
        onClick={dismiss}
        // Lighter than a modal scrim on purpose. The owner should still be
        // able to read the workspace they summoned J4 from — dimmed, not
        // replaced. That legibility is what makes this feel like J4 arrived
        // rather than like the dashboard was navigated away from.
        className={`absolute inset-0 bg-black/30 transition-opacity duration-300 md:bg-black/50 ${
          shown ? "opacity-100" : "opacity-0"
        }`}
      />

      <div
        // Grows out of the bottom-center — exactly where the J4 control sits
        // in the tab bar — rather than sliding in from off-screen as a
        // separate window. origin-bottom plus a small scale/fade reads as
        // "this expanded out of that button"; a pure translate-y read as
        // "a new screen arrived." Same distinction Sean drew: J4 isn't a
        // page I go to, J4 comes to me.
        className={`absolute inset-x-0 bottom-0 top-24 flex origin-bottom touch-auto flex-col overflow-hidden rounded-t-3xl bg-white shadow-2xl transition-[transform,opacity] duration-[380ms] dark:bg-zinc-950 md:top-0 md:rounded-none ${
          shown ? "translate-y-0 scale-100 opacity-100" : "translate-y-8 scale-[0.96] opacity-0"
        }`}
        style={{ transitionTimingFunction: "cubic-bezier(0.32, 0.72, 0, 1)" }}
      >
        <div className="relative flex shrink-0 items-center justify-end px-3 pt-2 md:hidden">
          <span
            className="absolute left-1/2 top-2.5 h-1 w-9 -translate-x-1/2 rounded-full bg-black/[.15] dark:bg-white/[.2]"
            aria-hidden="true"
          />
          {/* 44px minimum touch target (2026-08-12). This was a 20px icon in
              1.5 units of padding, roughly 32px square, and reported as
              genuinely hard to hit. The icon stays 20px; the hit area around
              it grew to the platform minimum. */}
          <button
            type="button"
            onClick={dismiss}
            aria-label="Close J4"
            className="-mr-1.5 flex h-11 w-11 items-center justify-center rounded-full text-zinc-500 active:bg-black/[.06] dark:text-zinc-400 dark:active:bg-white/[.08]"
          >
            <J4Icon name="close" size={20} />
          </button>
        </div>

        {/* overscroll-contain stops a scroll that reaches the end of J4's own
            content from chaining into the page underneath, which is how a
            gesture inside the overlay was still reaching the workspace. */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
      </div>
    </div>,
    document.body
  );
}
