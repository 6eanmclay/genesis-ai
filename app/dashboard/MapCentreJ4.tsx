"use client";

import type { J4State } from "@/components/j4/J4Character";

/**
 * J4 AT THE CENTRE OF HIS OWN MAP — REAR VIEW, AND MAP ONLY.
 *
 * ============ WHY THIS IS NOT A PROP ON J4Character (2026-09-18) ========
 *
 * Sean supplied the rear-view render and was explicit: "Use that rear-view J4
 * as the center visual for Business Map only. Do not replace the shared
 * J4Character artwork, because the front-view J4 is still required everywhere
 * else (dock, Office, conversation, etc.)."
 *
 * The obvious implementation — a `view="rear"` prop on J4Character — would
 * break a real invariant rather than merely being untidy. verify-j4-artwork
 * asserts that "the persistent J4 references exactly one asset", counting the
 * `/brand/...` paths in that file. That check is what keeps anything from ever
 * being composited over his visor again, and it exists because a face layer
 * once was. A second asset constant in there would fail it, and the fix would
 * have been to weaken the assertion.
 *
 * So the rear view lives here instead. The shared component keeps its one
 * asset, this one is map-only by construction rather than by convention, and
 * neither can quietly become the other.
 *
 * ============ WHAT THE ASSET IS ========================================
 *
 * Sean's isolated rear-view render: brain, headset, neck, shoulders and the J4
 * emblem, on its own ground.
 *
 * THE ISOLATED RENDER MATTERS, and it is worth saying why. The first asset
 * offered was the full composition, and the character could not be cut out of
 * it without bringing along the floating document, cube, person and platform
 * glyphs drawn around him. Those are the mockup's DEPICTION of data, and
 * baking them into the artwork would have printed permanent invented data
 * claims onto the map, sitting beside the real indicators the streams actually
 * carry. The map's own rule, in Sean's words: "These are not new data claims
 * and must not be invented."
 *
 * He supplied this render instead. Nothing is composited, nothing is cut from
 * the character, and the only thing applied is a feathered mask at the edges so
 * he ends in the environment rather than on a seam.
 *
 * ============ STATE IS LIGHT AROUND HIM, NEVER MARKS ON HIM ============
 *
 * The same rule J4Character follows, for the same reason. Nothing is drawn
 * over the render: what changes with state is a glow behind him.
 */

/** The map's own asset. Never the shared front-view render. */
const REAR = "/brand/j4-rear-map.png";
// Framed close on the brain, at Sean's direction — head, headset and the collar
// beneath it. The brain is the subject at map scale; the full-length render
// puts it at a size where the neural detail that carries the whole idea is
// simply gone.

/** The render's real proportions, so the box never distorts him. */
const REAR_ASPECT = 532 / 560;

/** How present he is, as light behind the render rather than marks on it. */
const STATE_GLOW: Record<J4State, string> = {
  idle: "34%",
  listening: "60%",
  thinking: "52%",
  speaking: "66%",
  success: "56%",
  attention: "48%",
};

export function MapCentreJ4({
  state,
  /** Width in CSS pixels; the height follows the render's own aspect. */
  width,
  title,
}: {
  state: J4State;
  width: number;
  title?: string;
}) {
  return (
    <div
      className="relative select-none"
      style={{ width, height: width * REAR_ASPECT }}
      data-map-centre-j4={state}
      title={title}
    >
      {/* HIS OWN LIGHT, BEHIND THE RENDER. The asset's ground is near-black and
          so is the stage, so without this he reads as a rectangle of slightly
          different black rather than as something lit. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute -inset-[18%] -z-10 rounded-full transition-all duration-700"
        style={{
          background: `radial-gradient(circle at 50% 42%, color-mix(in oklab, var(--map-known) ${STATE_GLOW[state]}, transparent) 0%, transparent 62%)`,
        }}
      />
      {/* The render itself, feathered at the edges so it sits IN the
          environment instead of ending on a hard rectangular seam. The mask is
          the only thing applied to it — no crop, no tint, no overlay. */}
      <img
        src={REAR}
        alt=""
        aria-hidden="true"
        draggable={false}
        className="absolute inset-0 h-full w-full object-contain"
        style={{
          maskImage:
            "radial-gradient(ellipse 66% 64% at 50% 48%, #000 62%, transparent 100%)",
          WebkitMaskImage:
            "radial-gradient(ellipse 66% 64% at 50% 48%, #000 62%, transparent 100%)",
        }}
      />
    </div>
  );
}
