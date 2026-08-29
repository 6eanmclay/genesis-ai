"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { GENESIS_GREEN } from "@/lib/brand/palette";

// THE CAROUSEL ITSELF, WITH NOTHING IN IT.
//
// ============ WHY THIS WAS EXTRACTED (2026-08-28) ======================
//
// Sean: "I want the Product Creation section to retain the same visual carousel
// experience we originally had — the immersive product imagery, focused center
// item, surrounding products, swipe/navigation, etc." And then, for social:
// "the same design philosophy... It should feel like the same Creation Station
// experience, not four generic blue buttons."
//
// That is one carousel with three sets of objects in it, not three carousels.
// So everything that makes it feel like the Creation Station — the circle, the
// depth, the light behind the focused object, the axis-locked swipe, the arrow
// keys, the breathing — lives here once, and each caller supplies only WHAT is
// floating and WHAT HAPPENS when you pick one.
//
// Nothing here knows about garments, suppliers, or platforms. A StageItem is an
// id, a label, and a drawing.
//
// ============ WHY A CIRCLE AND NOT A ROW ==============================
//
// A row has ends. Reaching one is a small failure — nothing there, go back —
// and it makes a set of five feel like a list of five. A circle has no ends:
// swiping always brings something forward, and the same gesture keeps working
// forever. Positions are trigonometric rather than hand-placed slots, so adding
// a sixth object changes nothing in this file.
//
// ============ MOTION IS A SIGNAL, NOT DECORATION ======================
//
// The focused object breathes; the others sit still. Green appears only on the
// focused one, and only faintly — the same language the voice glyph uses for
// "this is alive right now". `prefers-reduced-motion` removes all of it.

export interface StageItem {
  id: string;
  label: string;
  /** The drawing. Sized by the stage, so it should fill what it is given. */
  art: ReactNode;
}

export function CreationStage({
  items,
  index,
  onIndexChange,
  onChoose,
  ariaLabel,
  height = "h-[300px] sm:h-[360px]",
}: {
  items: StageItem[];
  /** Which object is forward. Owned by the caller so it can title the actions. */
  index: number;
  onIndexChange: (next: number) => void;
  onChoose: (item: StageItem) => void;
  ariaLabel: string;
  /** Tailwind height classes. Sections run shorter than the full-page doorway. */
  height?: string;
}) {
  const [entered, setEntered] = useState(false);
  const drag = useRef<{ startX: number; startY: number; axis: "x" | "y" | null } | null>(null);

  const count = items.length;
  const focusedIndex = count > 0 ? ((index % count) + count) % count : 0;
  const focused = items[focusedIndex];

  // A beat before the objects arrive, so entering reads as arriving somewhere
  // rather than a page that was already there.
  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // ============ KEYS FOLLOW FOCUS, NOT THE WINDOW (2026-08-28) ========
  //
  // This listened on `window`, which was fine while the carousel was the only
  // one on the page. The Studio landing now has TWO — Product Creation and
  // Social Creation — and two window listeners meant one arrow key rotated both
  // carousels at once, and Enter fired both actions: navigating to the garment
  // editor while simultaneously sending a post request to J4.
  //
  // Found by walking it, not by reading it. Both stages were correct in
  // isolation; the defect only exists in the presence of a second one.
  //
  // Element-level is also simply the right behaviour for a listbox: it is
  // tabIndex=0, so it takes focus, and the keys belong to whatever has focus.
  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      onIndexChange(index + 1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      onIndexChange(index - 1);
    } else if (event.key === "Enter" && focused) {
      event.preventDefault();
      onChoose(focused);
    }
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
  // THIS MATTERS MORE NOW THAN IT DID (2026-08-28). On the doorway the carousel
  // was the whole screen. In a section there is a page above and below it, so a
  // stage that swallowed vertical gestures would trap a thumb mid-scroll.
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
      onIndexChange(index + (dx > 0 ? -1 : 1));
      state.startX = event.clientX;
    }
  }

  function onPointerUp() {
    drag.current = null;
  }

  if (count === 0) return null;

  return (
    <div
      role="listbox"
      aria-label={ariaLabel}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      // pan-y, not none: the page keeps vertical scrolling. See the note above.
      className={`relative shrink-0 select-none outline-none ${height}`}
      style={{ perspective: 1200, touchAction: "pan-y" }}
    >
      {items.map((item, i) => {
        // Where this object sits on the circle, relative to what is focused.
        // Trigonometry rather than slots, so a sixth entry needs no new code.
        const offset = ((i - index) % count + count) % count;
        const angle = (offset / count) * Math.PI * 2;
        const x = Math.sin(angle);
        const z = Math.cos(angle);
        const isFocused = offset === 0;

        return (
          <button
            key={item.id}
            type="button"
            role="option"
            aria-selected={isFocused}
            aria-label={item.label}
            onClick={() => (isFocused ? onChoose(item) : onIndexChange(i))}
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
            <StageObject focused={isFocused}>{item.art}</StageObject>
          </button>
        );
      })}

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
 * Where you are in a circle that has no ends.
 *
 * Separate from the stage so each caller places it where its own layout wants
 * it — on the doorway it sits below the action, quieter than it.
 */
export function StageDots({
  count,
  index,
  ids,
}: {
  count: number;
  index: number;
  /** Stable keys. Indexes would do, but ids survive a reordered catalogue. */
  ids: string[];
}) {
  const active = count > 0 ? ((index % count) + count) % count : 0;
  return (
    // data-stage-dots is a DELIBERATE TEST HOOK, not decoration. The suite
    // asserts the action sits above the indicator, and it used to find these by
    // walking the DOM shape (`[role="listbox"] ~ div span`) — which broke the
    // moment the stage gained a wrapper, failing for a reason that had nothing
    // to do with the ordering it was guarding. A named hook survives layout.
    <div data-stage-dots="" className="flex items-center justify-center gap-1.5">
      {ids.map((id, i) => (
        <span
          key={id}
          aria-hidden="true"
          className="h-1.5 rounded-full transition-all duration-300"
          style={{
            width: i === active ? 18 : 6,
            background: i === active ? GENESIS_GREEN : "rgba(255,255,255,.22)",
          }}
        />
      ))}
    </div>
  );
}

/**
 * The object itself, floating.
 *
 * ============ NO CARD ================================================
 *
 * This used to be a bordered square with the product inside it, which meant the
 * thing in the space was a CARD and the product was its contents. Sean's
 * correction: "I don't want squares representing products. I want the actual
 * products floating there."
 *
 * So the chrome is gone. What remains is the drawing, lit by a glow behind it
 * rather than framed by a border — the light is in the space, not around the
 * object. Opacity dims the whole object at once, which is the depth cue.
 */
function StageObject({ focused, children }: { focused: boolean; children: ReactNode }) {
  return (
    <span
      className={focused ? "creation-portal-breathe block" : "block"}
      style={focused ? { animation: "creationPortalBreathe 4.5s ease-in-out infinite" } : undefined}
    >
      <span
        className="relative grid h-[190px] w-[190px] place-items-center transition-opacity duration-500 sm:h-[230px] sm:w-[230px]"
        style={{ opacity: focused ? 1 : 0.42 }}
      >
        {/* The light sits BEHIND the object, so the object is lit rather than
            outlined. Only the focused one is lit — that is the whole depth cue,
            and it is the same green the rest of the language uses for "this is
            alive right now". */}
        {focused && (
          <span
            aria-hidden="true"
            className="absolute inset-0 rounded-full blur-2xl"
            style={{ background: `radial-gradient(circle, ${GENESIS_GREEN}55 0%, transparent 70%)` }}
          />
        )}
        {children}
      </span>
    </span>
  );
}
