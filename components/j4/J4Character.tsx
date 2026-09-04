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
// So the face is an ASSET now. Sean supplied the canonical OFF image and a
// reference for the ON expression; the illuminated face was registered onto the
// OFF artwork by their shared green ring and lifted out as a transparent layer.
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
// visor. That is checked when the assets are generated rather than asserted
// here, because it is a property of the files.
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

// ONE CANONICAL PAIR, EVERYWHERE (2026-09-04).
//
// The dock briefly had its own separately-registered pair, and that is
// exactly how the two J4s drifted: two registrations, two scales, two sets
// of eye spacing. Sean's rule is one shared asset and state system, fixed
// once so the correction propagates - so both the entrance and the corner
// draw the same two files, and the size is the only thing that varies.
//
// The face layer is the MASTER'S OWN VISOR, pasted over the master's own
// artwork through a feathered ellipse. No threshold, no alpha ramp, no
// recomputed positions: the eyes and mouth are the master's pixels at the
// master's spacing, because they ARE the master's pixels.
const BASE = "/brand/j4-off.png";
const FACE = "/brand/j4-face-on.png";

export function J4Character({
  state = "idle",
  size = 96,
  title,
  awake = true,
}: {
  state?: J4State;
  skin?: J4Skin;
  gaze?: J4Gaze;
  size?: number;
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
      className="relative select-none"
      style={{ width: size, height: size }}
      data-j4-state={state}
      data-j4-awake={awake ? "true" : "false"}
      title={title}
    >
      <img
        src={BASE}
        alt=""
        aria-hidden="true"
        draggable={false}
        className="absolute inset-0 h-full w-full object-contain"
      />
      {/* THE LIGHT, IN THE SAME BOX. Same dimensions, same fit, same position —
          so turning it on is turning a light on inside the same image. */}
      <img
        src={FACE}
        alt=""
        aria-hidden="true"
        draggable={false}
        className="absolute inset-0 h-full w-full object-contain transition-opacity duration-300"
        style={{ opacity: awake ? 1 : 0 }}
      />
    </div>
  );
}
