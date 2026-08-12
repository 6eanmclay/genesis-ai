"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
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

  useEffect(() => {
    const raf = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // Dismissal has to animate too. router.back() on its own unmounts this
  // instantly, so J4 grew smoothly out of the control and then vanished — an
  // asymmetry you feel even if you can't name it. Reverse the entrance, then
  // navigate once it has actually played.
  const dismiss = useCallback(() => {
    setShown(false);
    window.setTimeout(() => router.back(), EXIT_MS);
  }, [router]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    document.addEventListener("keydown", onKey);
    // The page underneath must not scroll while J4 is over it — otherwise
    // dismissing returns the owner to a different scroll position than the
    // one they summoned him from, which reads as having lost their place.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [dismiss]);

  if (!mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true" aria-label="J4">
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
        className={`absolute inset-x-0 bottom-0 top-24 flex origin-bottom flex-col overflow-hidden rounded-t-3xl bg-white shadow-2xl transition-[transform,opacity] duration-[380ms] dark:bg-zinc-950 md:top-0 md:rounded-none ${
          shown ? "translate-y-0 scale-100 opacity-100" : "translate-y-8 scale-[0.96] opacity-0"
        }`}
        style={{ transitionTimingFunction: "cubic-bezier(0.32, 0.72, 0, 1)" }}
      >
        <div className="relative flex shrink-0 items-center justify-end px-3 pt-2 md:hidden">
          <span
            className="absolute left-1/2 top-2.5 h-1 w-9 -translate-x-1/2 rounded-full bg-black/[.15] dark:bg-white/[.2]"
            aria-hidden="true"
          />
          <button
            type="button"
            onClick={dismiss}
            aria-label="Close J4"
            className="rounded-full p-1.5 text-zinc-500 dark:text-zinc-400"
          >
            <J4Icon name="close" size={20} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>,
    document.body
  );
}
