"use client";

// J4 (2026-09-03, second pass — after Sean saw the first one).
//
// ============ WHAT CHANGED, AND WHY =================================
//
// The first version drew J4 entirely as vector geometry. It worked as a rig and
// read as a small chatbot button, which is exactly the critique: "the reference
// reads like a character". Hand-drawing toward a premium 3D render was never
// going to close that gap.
//
// So the render IS the character now. The supplied reference supplies the
// helmet, the armour, the ear module, the neck and shoulders, the bevels and
// the reflections — everything that makes him look built rather than iconified.
//
// ============ AND THE VISOR IS STILL A RIG ==========================
//
// One thing is deliberately NOT photographic: the face. A drawn visor sits over
// the render's own, and the eyes and mouth are shapes this file controls — so
// six states are six expressions of ONE LOCKED CHARACTER rather than six
// separate images that would drift apart. That is the "layers over one locked
// base" rule from J4_ASSET_SPECIFICATION.md, with the reference as the base.
//
// The alternative — swapping whole renders per state — is what produced a
// different character last time gpt-image-1 was asked to preserve locked
// regions.
//
// ============ THE API IS UNCHANGED ==================================
//
// Same props, same states, same consumers. When commissioned artwork arrives it
// replaces the file this points at; nothing else moves.

export type J4State =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "success"
  | "attention";

export type J4Skin = "light" | "dark";

/** Where J4 is looking. The eyes shift; the head does not spin. */
export type J4Gaze = "ahead" | "left" | "right" | "down";

const GREEN = "#5dfb4a";
const AMBER = "#ffd24a";

// Where the face sits on the reference render, as fractions of its 512 box.
// Measured off the asset rather than guessed, and kept here so a new render
// only has to restate these five numbers.
// TIGHTENED after seeing it at real size: the first ellipse was drawn to the
// full extent of the render's dark glass, which at 116px swallowed the white
// helmet and threw away the one thing the photograph was there to provide.
// The face only needs to cover the baked expression, not the whole visor.
const FACE = { cx: 0.541, cy: 0.487, rx: 0.163, ry: 0.172, eyeY: 0.478, mouthY: 0.600 };

export function J4Character({
  state = "idle",
  skin = "light",
  gaze = "ahead",
  size = 96,
  title,
}: {
  state?: J4State;
  skin?: J4Skin;
  gaze?: J4Gaze;
  size?: number;
  title?: string;
}) {
  const gazeX = gaze === "left" ? -9 : gaze === "right" ? 9 : 0;
  const gazeY = gaze === "down" ? 7 : 0;
  const uid = `j4-${state}-${skin}`;

  const cx = FACE.cx * 512;
  const cy = FACE.cy * 512;
  const eyeY = FACE.eyeY * 512;
  const mouthY = FACE.mouthY * 512;
  const eyeDx = 34;

  return (
    <svg
      viewBox="0 0 512 512"
      width={size}
      height={size}
      role={title ? "img" : "presentation"}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      data-j4-state={state}
      data-j4-skin={skin}
      style={{ display: "block", overflow: "visible" }}
    >
      <defs>
        <clipPath id={`${uid}-disc`}>
          <circle cx="256" cy="256" r="248" />
        </clipPath>
        {/* The drawn visor keeps the render's own depth rather than flattening
            to a black patch: brighter at the top-left where the helmet catches
            light, deep at the bottom. */}
        <radialGradient id={`${uid}-visor`} cx="38%" cy="30%" r="78%">
          <stop offset="0%" stopColor="#1b2a25" />
          <stop offset="55%" stopColor="#0a1310" />
          <stop offset="100%" stopColor="#030705" />
        </radialGradient>
        <filter id={`${uid}-soft`} x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="6" />
        </filter>
      </defs>

      <style>{`
        @keyframes j4b { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-4px) } }
        @keyframes j4p { 0%,100% { opacity: .5 } 50% { opacity: 1 } }
        @keyframes j4s { to { transform: rotate(360deg) } }
        @keyframes j4t { 0%,100% { transform: scaleY(.4) } 50% { transform: scaleY(1.3) } }
        .j4-float { animation: j4b 4.5s ease-in-out infinite }
        .j4-pulse { animation: j4p 1.4s ease-in-out infinite }
        .j4-spin  { animation: j4s 2.4s linear infinite; transform-origin: 256px 256px }
        .j4-talk  { animation: j4t .26s ease-in-out infinite; transform-origin: ${cx}px ${mouthY}px }
        @media (prefers-reduced-motion: reduce) {
          .j4-float, .j4-pulse, .j4-spin, .j4-talk { animation: none }
        }
      `}</style>

      <g clipPath={`url(#${uid}-disc)`}>
        <g className="j4-float">
          {/* THE CHARACTER HIMSELF. Everything premium about him — helmet
              panels, ear module, neck, shoulders, the light on the armour —
              comes from here, because that is what a drawing could not do. */}
          <image
            href="/brand/j4-character.png"
            x="0"
            y="0"
            width="512"
            height="512"
            preserveAspectRatio="xMidYMid slice"
          />

          {/* The face, drawn over the render's own so it can change. */}
          <g transform={`translate(${gazeX} ${gazeY})`}>
            <ellipse
              cx={cx}
              cy={cy}
              rx={FACE.rx * 512}
              ry={FACE.ry * 512}
              fill={`url(#${uid}-visor)`}
            />
            {/* A single soft highlight, so the drawn visor still reads as glass
                rather than a hole cut in his head. */}
            <ellipse
              cx={cx - 42}
              cy={cy - 62}
              rx="52"
              ry="30"
              fill="#7fe0c8"
              opacity="0.10"
              filter={`url(#${uid}-soft)`}
            />
            <g filter={`url(#${uid}-soft)`} opacity="0.55">
              <Face state={state} cx={cx} eyeY={eyeY} mouthY={mouthY} eyeDx={eyeDx} />
            </g>
            <Face state={state} cx={cx} eyeY={eyeY} mouthY={mouthY} eyeDx={eyeDx} />
          </g>
        </g>
      </g>

      {/* The frame. Thin at rest so it reads as containment rather than a halo;
          the old sonar bloom is exactly what the direction moved away from. */}
      <circle
        className={state === "listening" ? "j4-pulse" : undefined}
        cx="256"
        cy="256"
        r="248"
        fill="none"
        stroke={state === "attention" ? AMBER : GREEN}
        strokeWidth={state === "listening" || state === "attention" ? 14 : 9}
      />
      {state === "thinking" && (
        <circle
          className="j4-spin"
          cx="256"
          cy="256"
          r="248"
          fill="none"
          stroke={GREEN}
          strokeWidth="14"
          strokeLinecap="round"
          strokeDasharray="120 1440"
        />
      )}
    </svg>
  );
}

/**
 * Eyes and mouth. Drawn twice by the caller — once blurred underneath for the
 * glow the reference has, once sharp on top — so the light looks emitted rather
 * than printed.
 */
function Face({
  state,
  cx,
  eyeY,
  mouthY,
  eyeDx,
}: {
  state: J4State;
  cx: number;
  eyeY: number;
  mouthY: number;
  eyeDx: number;
}) {
  const stroke = { fill: "none", stroke: GREEN, strokeWidth: 12, strokeLinecap: "round" as const };
  const L = cx - eyeDx;
  const R = cx + eyeDx;

  const eyes =
    state === "listening" ? (
      // WIDE OPEN, and the only round-eyed state — "he is listening" has to be
      // readable at a glance, from across a desk.
      <g fill={GREEN}>
        <circle cx={L} cy={eyeY} r="16" />
        <circle cx={R} cy={eyeY} r="16" />
      </g>
    ) : state === "success" ? (
      <g {...stroke}>
        <path d={`M${L - 22} ${eyeY + 6} Q${L} ${eyeY - 20} ${L + 22} ${eyeY + 6}`} />
        <path d={`M${R - 22} ${eyeY + 6} Q${R} ${eyeY - 20} ${R + 22} ${eyeY + 6}`} />
      </g>
    ) : state === "thinking" ? (
      <g {...stroke}>
        <path d={`M${L - 22} ${eyeY - 4} Q${L} ${eyeY - 14} ${L + 22} ${eyeY - 4}`} />
        <path d={`M${R - 22} ${eyeY - 4} Q${R} ${eyeY - 14} ${R + 22} ${eyeY - 4}`} />
      </g>
    ) : (
      // The resting eye, matching the reference's own downward arc.
      <g {...stroke}>
        <path d={`M${L - 24} ${eyeY - 8} Q${L} ${eyeY + 16} ${L + 24} ${eyeY - 8}`} />
        <path d={`M${R - 24} ${eyeY - 8} Q${R} ${eyeY + 16} ${R + 24} ${eyeY - 8}`} />
      </g>
    );

  const mouth =
    state === "speaking" ? (
      <ellipse className="j4-talk" cx={cx} cy={mouthY} rx="26" ry="18" fill={GREEN} />
    ) : state === "attention" ? (
      <path d={`M${cx - 30} ${mouthY} h60`} {...stroke} />
    ) : state === "success" ? (
      <path d={`M${cx - 36} ${mouthY - 10} Q${cx} ${mouthY + 26} ${cx + 36} ${mouthY - 10}`} {...stroke} />
    ) : (
      <path d={`M${cx - 32} ${mouthY - 8} Q${cx} ${mouthY + 18} ${cx + 32} ${mouthY - 8}`} {...stroke} />
    );

  return (
    <g>
      {eyes}
      {mouth}
    </g>
  );
}
