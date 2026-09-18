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
 * Sean's standalone brain: a luminous neural mass on its own black ground, and
 * nothing else. "The brain should be the focal point — clean, luminous,
 * centered, and integrated into the existing environment. Do not put a
 * robot/headset/body behind it."
 *
 * It replaces the rear-view character that shipped in b0f0010. That render was
 * right for a portrait and wrong at map scale: head, headset and shoulders
 * spend most of the circle on hardware, and the neural detail — the thing the
 * whole idea rests on — ended up the smallest part of it. This asset IS that
 * detail.
 *
 * WHAT IS STILL TRUE OF IT. The artwork carries no depiction of data. An
 * earlier candidate was the full composition, and the character could not be
 * cut out of it without bringing along the floating document, cube, person and
 * platform glyphs drawn around him — the mockup's DEPICTION of data, which
 * baked in would have printed permanent invented claims onto the map beside
 * the real indicators the streams carry. The rule, in Sean's words: "These are
 * not new data claims and must not be invented." This asset is a brain.
 *
 * Nothing is composited and nothing is cut; the only thing applied is a
 * feathered mask so it ends in the environment rather than on a seam.
 *
 * ============ STATE IS LIGHT AROUND HIM, NEVER MARKS ON HIM ============
 *
 * The same rule J4Character follows, for the same reason. Nothing is drawn
 * over the render: what changes with state is a glow behind him.
 */

/** The map's own asset. Never the shared front-view render. */
const BRAIN = "/brand/j4-brain-map.png";

/** Square, so the centre is a disc rather than a portrait. */
const BRAIN_ASPECT = 1;

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
      style={{ width, height: width * BRAIN_ASPECT }}
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
        src={BRAIN}
        alt=""
        aria-hidden="true"
        draggable={false}
        className="absolute inset-0 h-full w-full object-contain"
        style={{
          maskImage:
            "radial-gradient(circle at 50% 50%, #000 34%, rgba(0,0,0,0.55) 52%, transparent 70%)",
          WebkitMaskImage:
            "radial-gradient(circle at 50% 50%, #000 34%, rgba(0,0,0,0.55) 52%, transparent 70%)",
        }}
      />
    </div>
  );
}
