"use client";

// J4 (2026-09-04, third pass — Sean's fixed OFF/ON assets).
//
// ============ TWO ASSETS, NOT A DRAWN FACE ==========================
//
// Every previous version drew the face: first as vector geometry, then as
// crescents over a blank visor. Both produced a face that was nearly right and
// visibly not his — the eyes ended up too close together, and during the
// entrance sequence it read as goofy. Approximating an artist's illustration in
// CSS was never going to close that gap.
//
// So the face is an ASSET now. Sean supplied the canonical OFF badge and a
// reference showing the same render with his face lit; the ON reference was
// registered onto the badge by searching for the scale and offset that make
// their ARMOUR agree, and the illuminated visor was lifted out as a transparent
// layer. Registering by a single landmark is what produced the earlier
// near-misses: a landmark measured slightly wrong gives a slightly wrong scale,
// and a slightly wrong scale is exactly what "the eyes are too close together"
// looks like.
//
// ============ THE ARTWORK CANNOT MOVE ===============================
//
// There is ONE base image and ONE light layer over it, in the same box, both
// object-contain. Switching states changes an opacity and nothing else — no
// swap of the base, no second copy of the character, no repositioning. That is
// why it cannot shift, scale or crop between OFF and ON: there is nothing in
// the mechanism that could.
//
// The layer was also built so that ON and OFF differ in ZERO pixels outside the
// visor. That is a property of the files, so it is proven against the files:
// verify-j4-artwork decodes both and composites them. It used to say "checked
// when the assets are generated", which is the kind of claim that is true on
// the day it is written and unfalsifiable afterwards.
//
// ============ THE API IS UNCHANGED ==================================
//
// Same props, same J4State, same data-j4-state attribute the shell and the
// harness read. What changed is only what gets painted.

export type J4State =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "success"
  | "attention";

export type J4Skin = "light" | "dark";

/** Kept for API compatibility. Gaze is no longer drawn — see the note above. */
export type J4Gaze = "ahead" | "left" | "right" | "down";

// THE WORKING STATE, NOT THE GREETING (2026-09-05).
//
// Sean: think of J4 like a dog when its person comes home. The entrance is the
// excited greeting; once the greeting is over he settles, and is calm and
// present. Those are two different pictures, and the corner was showing the
// wrong one - the greeting artwork, with its green energy field, swirls and
// globe, parked permanently in the corner of every screen.
//
// So the persistent surfaces draw the CALM badge: black ground, a very subtle
// honeycomb behind him, J4 clean and clearly visible, no energy around him.
// The entrance keeps the green artwork, and owns it alone - see J4Boot, which
// references its files directly rather than through this component.
//
// TWO PICTURES IS NOT THE DRIFT SEAN BANNED. The rule that was set after the
// dock and the entrance disagreed is that nothing may be SEPARATELY REGISTERED:
// two registrations meant two scales and two sets of eye spacing, and J4's face
// came out subtly different in the two places. Here each state is one base plus
// its own face layer, registered once, and no surface re-derives either. The
// corner and the workspace draw the same two files as each other; size is still
// the only thing that varies between them.
//
// The calm face layer is the ON RENDER'S OWN VISOR, carried onto the badge
// through a feathered ellipse that stays inside the visor glass. No threshold,
// no alpha ramp, no recomputed positions: the eyes and mouth are the artist's
// pixels at the artist's spacing, because they ARE the artist's pixels. Neither
// master was modified to produce it. verify-j4-artwork proves both halves of
// that on the files themselves.
const BASE = "/brand/j4-v2.png";

/**
 * State, as light AROUND J4 rather than marks ON him.
 *
 * ============ THE VISOR IS NEVER DRAWN ON (2026-09-09, Sean) ===========
 *
 * The new direction is explicit: "Black visor remains completely clean" and
 * "Never put the symbol on the visor itself." That retires the face layer this
 * component carried — `j4-calm-face-on.png`, the eyes and smile — and with it
 * the OFF/ON mechanism that painted a second image inside the same box.
 *
 * So state moved outside the artwork entirely. This is one ring on the
 * CONTAINER: no pixel of the render is covered, nothing is composited over the
 * visor, and there is nothing here that could drift into being a face. It also
 * keeps the earlier rule intact — no runtime-generated expressions — because a
 * border colour is not an expression.
 *
 * The character's own emblem and ear module already glow in the render. This
 * ring is the part that can change; those are the part that cannot.
 */
const STATE_RING: Record<J4State, string> = {
  idle: "ring-[#4ade3a]/25",
  listening: "ring-[#4ade3a]/80 animate-pulse",
  thinking: "ring-[#4ade3a]/50 animate-pulse",
  speaking: "ring-[#4ade3a]/90",
  success: "ring-[#4ade3a]/70",
  attention: "ring-amber-400/80",
};

export function J4Character({
  state = "idle",
  size = 96,
  title,
  awake = true,
}: {
  state?: J4State;
  skin?: J4Skin;
  gaze?: J4Gaze;
  /**
   * A pixel size, or "fill" to take the width of whatever contains him.
   *
   * "fill" exists so the dock can size J4 from --j4-dock-reserve, the single
   * declaration the navigation also reads. Before that, the dock scaled him
   * independently of the space the bar held for him, and the two disagreed:
   * two rooms ended up underneath him. Sizing from the reserve means he
   * cannot outgrow the room made for him. The artwork is untouched - this is
   * the box, not the picture.
   */
  size?: number | "fill";
  title?: string;
  /**
   * Whether his face is lit.
   *
   * OFF is genuinely off — the base artwork with its black visor, which is what
   * the entrance sequence starts from. Everything else is ON. There are only
   * these two states, deliberately: a face that is nearly right in six subtly
   * different ways is worse than one that is exactly right in two.
   */
  awake?: boolean;
}) {
  return (
    <div
      className={`relative select-none${size === "fill" ? " aspect-square w-full" : ""}`}
      style={size === "fill" ? undefined : { width: size, height: size }}
      data-j4-state={state}
      data-j4-awake={awake ? "true" : "false"}
      title={title}
    >
      <img
        src={BASE}
        alt=""
        aria-hidden="true"
        draggable={false}
        className="absolute inset-0 h-full w-full object-contain transition-opacity duration-300"
        style={{ opacity: awake ? 1 : 0.55 }}
      />
      {/* STATE IS LIGHT AROUND HIM, NEVER MARKS ON HIM.
          A ring outside the artwork, so the visor stays clean and no pixel of
          the render is drawn over. Nothing here is a face and nothing here is
          generated — it is one border whose colour and pulse follow state. */}
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute inset-0 rounded-[22%] ring-1 transition-all duration-500 ${STATE_RING[state]}`}
      />
    </div>
  );
}
