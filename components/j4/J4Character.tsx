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

// THE DOCK'S OWN PAIR, not the entrance's.
//
// Same J4, same identity, no business icons. The full canonical badge carries
// six hexagons and a globe, which at 116px in the corner is noise rather than
// information - so the compact presentation uses the icon-free crop of the
// same character, with the same illuminated face registered onto its visor.
//
// The entrance sequence uses the full badge, because there the six icons ARE
// the story.
const BASE = "/brand/j4-character.png";
const FACE = "/brand/j4-dock-face.png";

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
