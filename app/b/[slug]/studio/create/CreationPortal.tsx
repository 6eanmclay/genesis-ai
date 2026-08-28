// ============ ILLUSTRATED HERE, PHOTOGRAPHED IN THE EDITOR ==============
//
// Sean, after seeing both: "The creation carousel should be a Genesis-branded
// discovery experience, not a supplier catalog... Once the user selects a
// product and enters the actual design/editor experience, that's where we
// should switch to the real Printful product photography/blanks."
//
// So this room draws. Every object is the same weight, the same light and the
// same neutral white whatever supplier is connected — which is what makes it a
// place rather than a grid of whatever Printful happens to photograph. The
// green is the aura BEHIND the object; the garment itself is never tinted.
//
// The real product, its real colours, its real front and back and its real
// lighting all begin one step later, in the editor. That transition is the
// point: out of the Genesis world and into the manufacturing one.
//
// This is NOT the fallback that used to be here. A fallback apologises for
// itself — the old copy said "outline drawn by Genesis, your supplier has no
// image" — and this is the intended thing, so it does not.
//
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { PortalItem } from "@/lib/creation/creatables";
import { GENESIS_BLACK, GENESIS_GREEN } from "@/lib/brand/palette";
import { CreatableArt } from "./CreatableArt";

// THE DOORWAY INTO CREATING.
//
// ============ THIS IS NOT A PRODUCT PICKER ==============================
//
// Sean's brief: entering the Creation Station should feel like Genesis opening
// a creative portal, the way the welcome experience does — not like landing on
// a page of options. The first thing asked is "what do you want to create?",
// and the answer arrives as objects in a space rather than rows in a list.
//
// So the object IS the control. There is no card with a button on it; the
// thing you are choosing is the thing you touch, and it moves.
//
// ============ WHY A CIRCLE AND NOT A ROW ================================
//
// A row has ends. Reaching one is a small failure — nothing there, go back —
// and it makes a set of five feel like a list of five. A circle has no ends:
// swiping always brings something forward, and the same gesture keeps working
// forever. It is also why this scales past five without redesign, which the
// catalogue in lib/creation/creatables.ts is built to allow.
//
// Positions are trigonometric rather than a set of hand-placed slots: each
// item sits at its own angle, and depth comes from where that angle puts it.
// Adding a sixth creatable changes nothing here.
//
// ============ MOTION IS A SIGNAL, NOT DECORATION ========================
//
// The focused object breathes; the others sit still. Green appears only on the
// focused one, and only faintly — the same language the voice glyph uses for
// "this is alive right now". `prefers-reduced-motion` removes all of it.

const GREEN = GENESIS_GREEN;

export function CreationPortal({
  items,
  basePath,
  hasSupplier,
  catalogueUnreadable,
}: {
  items: PortalItem[];
  basePath: string;
  /** False when no print supplier is connected — see the note below. */
  hasSupplier: boolean;
  /**
   * True when a supplier IS connected but its catalogue could not be read.
   *
   * Without this the portal cannot tell "they don't make hats" from "we never
   * found out", and an empty list reads as the first — see the note below.
   */
  catalogueUnreadable: boolean;
}) {
  const router = useRouter();
  const [index, setIndex] = useState(0);
  const [entered, setEntered] = useState(false);
  const drag = useRef<{ startX: number; startY: number; axis: "x" | "y" | null } | null>(null);

  const count = items.length;
  const focused = items[((index % count) + count) % count];

  // A beat before the objects arrive, so entering reads as arriving somewhere
  // rather than a page that was already there.
  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const rotate = useCallback((by: number) => setIndex((i) => i + by), []);

  // Arrow keys do what the swipe does. The carousel is the only control on
  // this screen, so it has to be reachable without a pointer.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight") rotate(1);
      else if (event.key === "ArrowLeft") rotate(-1);
      else if (event.key === "Enter" && focused) choose(focused);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function choose(item: PortalItem) {
    // The intention travels, not a product id. Which blank comes next is the
    // page's decision — see its own comment on why that split matters.
    router.push(`${basePath}/studio/create?kind=${encodeURIComponent(item.creatable.id)}`);
  }

  // ============ HORIZONTAL IS OURS, VERTICAL IS THE PAGE'S ============
  //
  // The stage used to carry `touch-none`, which told the browser this element
  // handles ALL gestures — so a finger anywhere near the carousel could not
  // scroll the page, and Sean had to hunt for a safe strip to scroll in.
  //
  // `touch-action: pan-y` is the fix, and it is the browser doing the work
  // rather than us: vertical panning stays with the page, horizontal comes
  // here. The axis test below is the same decision made for pointer events,
  // which do not honour touch-action on their own.
  //
  // The axis is decided ONCE per gesture and then held. Re-deciding every move
  // makes a slightly diagonal swipe flicker between scrolling and rotating,
  // which feels broken in a way nobody can describe.
  function onPointerDown(event: React.PointerEvent) {
    drag.current = { startX: event.clientX, startY: event.clientY, axis: null };
  }

  function onPointerMove(event: React.PointerEvent) {
    const state = drag.current;
    if (!state) return;

    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;

    if (state.axis === null) {
      // Nothing is claimed until the gesture has travelled far enough to have
      // a direction. Ten pixels is below the threshold at which anybody has
      // decided what they are doing.
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      state.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
    }

    // A vertical gesture is the page's. Doing nothing here is what lets it
    // scroll normally.
    if (state.axis === "y") return;

    // One step per threshold, so a long swipe travels several places rather
    // than one — which is what makes a big set feel reachable.
    const step = 90;
    if (Math.abs(dx) >= step) {
      rotate(dx > 0 ? -1 : 1);
      state.startX = event.clientX;
    }
  }

  function onPointerUp() {
    drag.current = null;
  }

  return (
    <div className="relative min-h-[calc(100vh-4rem)] overflow-hidden text-zinc-100"
      style={{ background: GENESIS_BLACK }}>
      {/* The space itself. A single soft light behind the focused object, so
          the object is lit rather than the page being decorated. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-[38%] h-[520px] w-[520px] -translate-x-1/2 -translate-y-1/2 rounded-full opacity-70 blur-3xl"
        style={{ background: `radial-gradient(circle, ${GREEN}22 0%, transparent 68%)` }}
      />

      <div className="relative mx-auto flex min-h-[calc(100vh-4rem)] max-w-5xl flex-col px-5 py-10">
        <header
          className="text-center transition-all duration-700"
          style={{ opacity: entered ? 1 : 0, transform: entered ? "none" : "translateY(8px)" }}
        >
          <h1 className="text-[26px] font-semibold tracking-tight sm:text-[32px]">
            What do you want to create?
          </h1>
          <p className="mx-auto mt-2 max-w-sm text-[14px] text-zinc-400">
            Swipe to look around. Pick one and we&apos;ll start making it.
          </p>
        </header>

        {/* THE STAGE. Objects live here; nothing else does. */}
        <div
          role="listbox"
          aria-label="What to create"
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          // pan-y, not none: the page keeps vertical scrolling. See the
          // gesture note above.
          className="relative mt-4 h-[300px] shrink-0 select-none outline-none sm:h-[360px]"
          style={{ perspective: 1200, touchAction: "pan-y" }}
        >
          {items.map((item, i) => {
            // Where this object sits on the circle, relative to what is
            // focused. Trigonometry rather than slots, so a sixth entry needs
            // no new code.
            const offset = ((i - index) % count + count) % count;
            const angle = (offset / count) * Math.PI * 2;
            const x = Math.sin(angle);
            const z = Math.cos(angle);
            const isFocused = offset === 0;

            return (
              <button
                key={item.creatable.id}
                type="button"
                role="option"
                aria-selected={isFocused}
                aria-label={item.creatable.label}
                onClick={() => (isFocused ? choose(item) : setIndex(i))}
                className="absolute left-1/2 top-[46%] -translate-x-1/2 -translate-y-1/2 transition-all duration-500 ease-out"
                style={{
                  // Depth: further back is smaller, dimmer, and behind.
                  transform: `translate3d(${x * 190}px, ${(1 - z) * 14}px, 0) scale(${0.52 + ((z + 1) / 2) * 0.48})`,
                  opacity: entered ? 0.18 + ((z + 1) / 2) * 0.82 : 0,
                  zIndex: Math.round((z + 1) * 100),
                  filter: isFocused ? "none" : "blur(0.6px)",
                  pointerEvents: z < 0 ? "none" : "auto",
                }}
              >
                <ObjectFace item={item} focused={isFocused} />
              </button>
            );
          })}
        </div>

        {/* ============ WHAT IS SELECTED, AND WHAT TO DO WITH IT ==========
            Lifted off the bottom, where it sat next to the navigation bar and
            was easy to miss. Sean: this whole block needs enough room that
            somebody immediately understands "this is what I've selected, and
            this is what I can do with it".

            Order matters here — name, then what it is, then the action, then
            the dots. The indicator is the least important thing on the screen
            and now reads as such rather than competing with the button.

            The button stays even though tapping the object does the same
            thing: not everybody will guess that the product itself is the
            control, and an explicit way in costs nothing. */}
        <div className="relative z-10 mt-6 text-center sm:mt-8">
          <p className="text-[22px] font-medium">{focused?.creatable.label}</p>
          <p className="mx-auto mt-1.5 max-w-xs text-[13px] text-zinc-400">
            {/* ============ EMPTY IS NOT THE SAME AS ABSENT =============
                Sean, looking at a portal where every single object claimed the
                supplier didn't make it: "even when you are picking between
                tshirt hoodie hat it's already saying your supplier doesn't
                make this one."

                He was right, and it was a lie. The catalogue call had thrown,
                so the garment list was empty — and empty was being read as
                "the supplier stocks none of these". Printful makes all five.

                "Your supplier doesn't make this one" is only TRUE when the
                catalogue was read successfully and had nothing matching. That
                is now the only case it is said in. */}
            {/* NO CAVEAT ABOUT WHOSE PICTURE THIS IS, because it is no longer
                standing in for one. The drawing is the intended illustration
                here — see the note at the top of this file — and saying "drawn
                by Genesis" about a deliberately Genesis-branded room would be
                apologising for the design. What still has to be honest is
                INVENTORY, which is the branch below. */}
            {focused?.available
              ? `${focused.blankCount} to choose from · ${focused.creatable.hint}`
              : catalogueUnreadable
                ? "We couldn't read your supplier's catalogue just now"
                : hasSupplier
                  ? "Your supplier doesn't make this one"
                  : focused?.creatable.hint}
          </p>

          <button
            type="button"
            onClick={() => focused && choose(focused)}
            className="mt-6 rounded-full px-7 py-3 text-[15px] font-medium text-white transition hover:brightness-110"
            style={{ background: GREEN }}
          >
            Make a {focused?.creatable.label.toLowerCase()}
          </button>

          {/* Dots, because a circle with no ends needs something to say where
              you are in it. Below the action and quieter than it. */}
          <div className="mt-7 flex items-center justify-center gap-1.5 pb-2">
            {items.map((item, i) => (
              <span
                key={item.creatable.id}
                aria-hidden="true"
                className="h-1.5 rounded-full transition-all duration-300"
                style={{
                  width: i === ((index % count) + count) % count ? 18 : 6,
                  background: i === ((index % count) + count) % count ? GREEN : "rgba(255,255,255,.22)",
                }}
              />
            ))}
          </div>
        </div>
      </div>

      <style>{`
        @media (prefers-reduced-motion: reduce) {
          .creation-portal-breathe { animation: none !important; }
        }
        @keyframes creationPortalBreathe {
          0%, 100% { transform: translateY(0); }
          50%      { transform: translateY(-6px); }
        }
      `}</style>
    </div>
  );
}

/**
 * The object itself, floating.
 *
 * ============ NO CARD ================================================
 *
 * This used to be a bordered square with the product inside it, which meant
 * the thing in the space was a CARD and the product was its contents. Sean's
 * correction: "I don't want squares representing products. I want the actual
 * products floating there."
 *
 * So the chrome is gone. What remains is the product, lit by a glow behind it
 * rather than framed by a border — the light is in the space, not around the
 * object.
 *
 * A supplier photograph wins whenever there is one, because a real blank is
 * more honest than a drawing of one. Where there is none — which is every
 * business before a supplier is connected — a white rendering stands in,
 * because the other half of his correction is the part a label cannot
 * satisfy: "I shouldn't have to read T-shirt to know I'm looking at a
 * T-shirt."
 */
function ObjectFace({ item, focused }: { item: PortalItem; focused: boolean }) {
  return (
    <span
      className={focused ? "creation-portal-breathe block" : "block"}
      style={focused ? { animation: "creationPortalBreathe 4.5s ease-in-out infinite" } : undefined}
    >
      {/* HOW LIT THIS ONE IS, decided once for the whole object.
          It used to be a text colour the drawn artwork inherited, which
          stopped meaning anything the moment the objects became shaded
          renderings rather than one-colour shapes — and never touched a
          supplier photograph at all. Opacity dims both the same way, so a
          business with photographs and a business without get the same
          sense of depth. */}
      <span
        className="relative grid h-[190px] w-[190px] place-items-center transition-opacity duration-500 sm:h-[230px] sm:w-[230px]"
        style={{ opacity: focused ? 1 : 0.42 }}
      >
        {/* The light sits BEHIND the object, so the object is lit rather than
            outlined. Only the focused one is lit — that is the whole depth
            cue, and it is the same green the rest of the language uses for
            "this is the live one". */}
        {focused && (
          <span
            aria-hidden="true"
            className="absolute inset-0 rounded-full blur-2xl"
            style={{ background: `radial-gradient(circle, ${GREEN}55 0%, transparent 70%)` }}
          />
        )}

        {/* ============ A CUTOUT, NEVER A PHOTOGRAPH (2026-08-27) =========

            This preferred the supplier's own photograph, on the reasoning that
            a real blank beats a drawing of one. That was right for a shelf and
            wrong for this room, and it only became visible the hour Printful's
            catalogue started answering — before that imageUrl was always null
            and nobody had seen the other branch.

            Printful's catalogue images are photographs on a white ground, and
            several are LIFESTYLE shots: a person wearing the garment. Dropped
            into a dark room they read as white rectangles, and there is no
            background-removal that fixes them — you cannot cut a model out of
            a photo and be left with a white hoodie floating in space. The
            product is not separable from the picture.

            Sean: "I do not want a white square behind the product. The
            Creation Station background should be visible all the way around."

            So the portal draws. These have no background to remove: they are
            paths, so the room and its glow show through everywhere the object
            is not. The supplier's real photographs still carry the shelf, one
            step later, where the question is WHICH blank rather than WHAT to
            make — and there a photograph on white inside a card is right. */}
        <CreatableArt id={item.creatable.id} className="relative h-[86%] w-[86%]" />
      </span>
    </span>
  );
}
