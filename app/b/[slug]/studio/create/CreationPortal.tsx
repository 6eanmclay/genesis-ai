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

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { PortalItem } from "@/lib/creation/creatables";
import { availabilityLine, kindHref } from "@/lib/creation/creationPresentation";
import { GENESIS_BLACK, GENESIS_GREEN } from "@/lib/brand/palette";
import { CreatableArt } from "./CreatableArt";
import { CreationStage, StageDots } from "./CreationStage";

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

  const count = items.length;
  const focused = items[((index % count) + count) % count];

  // A beat before the header arrives, so entering reads as arriving somewhere
  // rather than a page that was already there. The objects have their own.
  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, []);

  function choose(item: PortalItem) {
    // The intention travels, not a product id. Which blank comes next is the
    // page's decision — see its own comment on why that split matters.
    //
    // The URL is built by creationPresentation, not here, so the Studio
    // carousels cannot drift from the doorway about where a card goes.
    router.push(kindHref(basePath, item.creatable.id));
  }

  // WHETHER THE FOCUSED THING CAN BE MADE, and the sentence that says so.
  // Lifted out of the JSX into the shared rule — the four-branch ternary that
  // used to sit inline is the one Sean caught lying about an unreadable
  // catalogue, and it now has exactly one home.
  const focusedLine = focused ? availabilityLine(focused, { hasSupplier, catalogueUnreadable }) : null;

  // ============ THE CAROUSEL ITSELF NOW LIVES IN CreationStage =========
  //
  // The circle, the depth maths, the axis-locked swipe, the arrow keys and the
  // breathing were extracted (2026-08-28) so Product Creation and Social
  // Creation on the Studio landing run the SAME carousel rather than a lookalike.
  //
  // Nothing about this page changed in the move. What is still here is what is
  // particular to the doorway: it owns the whole viewport, it asks the question
  // in a headline, and its action is "Make a t-shirt".
  const stageItems = items.map((item) => ({
    id: item.creatable.id,
    label: item.creatable.label,
    art: <CreatableArt id={item.creatable.id} className="relative h-[86%] w-[86%]" />,
  }));

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

        <div className="mt-4">
          <CreationStage
            items={stageItems}
            index={index}
            onIndexChange={setIndex}
            onChoose={(item) => {
              const chosen = items.find((i) => i.creatable.id === item.id);
              if (chosen) choose(chosen);
            }}
            ariaLabel="What to create"
          />
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
            {focusedLine}
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
          <div className="mt-7 pb-2">
            <StageDots count={count} index={index} ids={items.map((i) => i.creatable.id)} />
          </div>
        </div>
      </div>
    </div>
  );
}
