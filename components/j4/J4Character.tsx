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
// RE-MEASURED 2026-09-04 for the Concept 2 base. The asset changed from a
// head crop of the busy badge to the full circular frame Sean specified, so
// every one of these moved. The visor ellipse was verified by drawing it back
// over the artwork before anything was repainted, because the previous
// estimate had swallowed part of the helmet.
// MEASURED ON THE CANONICAL ASSET (2026-09-04). Sean supplied the final
// image - full green ring, blank visor, nothing else - and it is installed
// uncropped and unmodified. These five numbers are the only thing that knows
// where his glass is, and they were checked by drawing the ellipse back over
// the artwork before anything relied on them.
const FACE = { cx: 0.575, cy: 0.435, rx: 0.180, ry: 0.195, eyeY: 0.377, mouthY: 0.517 };

export function J4Character({
  state = "idle",
  skin = "light",
  gaze = "ahead",
  size = 96,
  title,
  mouthOpenness,
}: {
  state?: J4State;
  skin?: J4Skin;
  gaze?: J4Gaze;
  size?: number;
  title?: string;
  /**
   * How open his mouth is right now, 0 to 1 - THE SEAM FOR A REAL VOICE.
   *
   * Left undefined, the speaking state animates on a rhythm, and that rhythm
   * is honestly a rhythm: it does not claim to match words nobody has
   * synthesised. When a voice pipeline exists it drives this per frame and
   * the animation stops - synchronisation then comes from the audio rather
   * than from a guess that happens to look plausible.
   *
   * The distinction matters because a fake sync is worse than none: it
   * teaches the owner to read a mouth that is not telling them anything.
   */
  mouthOpenness?: number | null;
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
        {/* LIGHT ON GLASS, not a lid over it. The visor gradient above used
            to be painted opaque across the render's own visor; this replaces
            it with a bloom that leaves the photograph visible underneath. */}
        <radialGradient id={`${uid}-glow`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={GREEN} stopOpacity="0.20" />
          <stop offset="55%" stopColor={GREEN} stopOpacity="0.07" />
          <stop offset="100%" stopColor={GREEN} stopOpacity="0" />
        </radialGradient>
        <filter id={`${uid}-soft`} x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="6" />
        </filter>
      </defs>

      <style>{`
        /* ---- THE VISOR IS A DISPLAY, AND THIS IS ITS VOCABULARY -------

           Every state below is LIGHT on one unchanging character. Nothing
           here swaps an image, and nothing here is a loading indicator
           wearing a face: a spinner says the system is busy, whereas eyes
           that hold you and then look away say J4 heard you and is thinking
           about it. That difference is the entire point of the blank glass.

           The two listening drifts run on 5.3s and 7.1s deliberately. Equal
           or harmonic periods make a loop the eye can count, and anything
           countable stops reading as alive. */

        @keyframes j4b { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-4px) } }
        @keyframes j4p { 0%,100% { opacity: .5 } 50% { opacity: 1 } }
        @keyframes j4s { to { transform: rotate(360deg) } }

        /* LISTENING: micro-saccades. Real eyes never hold perfectly still,
           and a static pair of glowing dots reads as a graphic rather than
           attention. */
        @keyframes j4lx {
          0%, 38%   { transform: translateX(0) }
          43%, 57%  { transform: translateX(5px) }
          62%, 86%  { transform: translateX(-4px) }
          91%, 100% { transform: translateX(0) }
        }
        @keyframes j4ly {
          0%, 28%   { transform: translateY(0) }
          33%, 62%  { transform: translateY(-3px) }
          68%, 100% { transform: translateY(2px) }
        }
        /* A blink, rarely. Most of the cycle is simply open. */
        @keyframes j4bl {
          0%, 92%, 100% { transform: scaleY(1) }
          95%, 97%      { transform: scaleY(.08) }
        }

        /* THINKING: deliberate gaze shifts, held. Up and away is what a
           person does while recalling something, and holding each position
           is what separates thought from fidgeting. */
        @keyframes j4pd {
          0%, 14%   { transform: translate(-15px, -11px) }
          28%, 46%  { transform: translate(12px, -13px) }
          60%, 78%  { transform: translate(-7px, -5px) }
          92%, 100% { transform: translate(-15px, -11px) }
        }

        /* SPEAKING: the fallback mouth, used only while nothing is driving
           mouthOpenness. It is honest about being a rhythm rather than
           lip-sync - see the prop's own note. */
        @keyframes j4t {
          0%, 100% { transform: scaleY(.34) }
          22%      { transform: scaleY(1.15) }
          48%      { transform: scaleY(.52) }
          74%      { transform: scaleY(1.3) }
        }

        /* IDLE: one slow breath in the bloom, and nothing else moving. */
        @keyframes j4br { 0%,100% { opacity: .55 } 50% { opacity: .9 } }

        .j4-float { animation: j4b 4.5s ease-in-out infinite }
        .j4-pulse { animation: j4p 1.4s ease-in-out infinite }
        .j4-spin  { animation: j4s 2.4s linear infinite; transform-origin: 256px 256px }
        .j4-lx    { animation: j4lx 5.3s ease-in-out infinite }
        .j4-ly    { animation: j4ly 7.1s ease-in-out infinite }
        .j4-blink { animation: j4bl 6.8s ease-in-out infinite; transform-origin: ${cx}px ${eyeY}px }
        .j4-ponder{ animation: j4pd 5.6s ease-in-out infinite }
        .j4-talk  { animation: j4t .3s ease-in-out infinite; transform-origin: ${cx}px ${mouthY}px }
        .j4-breathe { animation: j4br 6s ease-in-out infinite }

        /* REDUCED MOTION STILL HAS A FACE. Everything stops moving; the eyes
           and mouth stay in their state's resting shape, so J4 still reads
           as listening or thinking without anything animating. */
        @media (prefers-reduced-motion: reduce) {
          .j4-float, .j4-pulse, .j4-spin, .j4-lx, .j4-ly,
          .j4-blink, .j4-ponder, .j4-talk, .j4-breathe { animation: none }
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

          {/* ============ THE FACE IS LIGHT ON REAL GLASS ==============

              CHANGED 2026-09-04, on Sean's note that the reference IS the
              character and must not be reduced to a geometric drawing.

              This used to paint an OPAQUE ellipse across the render's own
              visor and draw the face on that. It had to: the render had a
              smile baked into the glass, and the only way to show any other
              state was to cover it. The cost was the photograph - at dock
              size the visor became a flat shape sitting in a detailed helmet.

              The expression now comes off the ASSET instead. The base render
              was re-cut from the 1254px reference at native 860 (up from a
              512 downscale) and the baked eyes and mouth were removed from
              the glass itself, with its gradient and specular highlight kept.
              So there is nothing left to hide, and what is drawn here is only
              illumination: a bloom, then the eyes and mouth, over glass that
              is still photographic.

              The character is therefore identical in every state - only the
              light on his visor changes, which is exactly the rule in
              J4_ASSET_SPECIFICATION.md. */}
          <g transform={`translate(${gazeX} ${gazeY})`}>
            <ellipse
              cx={cx}
              cy={cy + 10}
              rx={FACE.rx * 512 * 1.25}
              ry={FACE.ry * 512 * 1.15}
              fill={`url(#${uid}-glow)`}
              className={state === "idle" ? "j4-breathe" : undefined}
              opacity={state === "idle" ? undefined : 1}
            />
            <g filter={`url(#${uid}-soft)`} opacity="0.8">
              <Face state={state} cx={cx} eyeY={eyeY} mouthY={mouthY} eyeDx={eyeDx} mouthOpenness={mouthOpenness} />
            </g>
            <Face state={state} cx={cx} eyeY={eyeY} mouthY={mouthY} eyeDx={eyeDx} mouthOpenness={mouthOpenness} />
          </g>
        </g>
      </g>

      {/* THE RING IS THE ARTWORK'S NOW. The base is cut to Concept 2's own
          green circular frame, so drawing a second one at rest gave J4 two
          rings of slightly different greens. What is drawn here is only the
          part that MEANS something: a ring that thickens and pulses while he
          is listening, and turns amber when something needs the owner. At
          idle there is nothing here at all and the artwork speaks for itself. */}
      {(state === "listening" || state === "attention") && (
        <circle
          className={state === "listening" ? "j4-pulse" : undefined}
          cx="256"
          cy="256"
          r="248"
          fill="none"
          stroke={state === "attention" ? AMBER : GREEN}
          strokeWidth="14"
        />
      )}
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
 * J4's face: eyes and mouth, drawn as light on his blank visor.
 *
 * Drawn twice by the caller - once blurred underneath for the bloom the
 * reference has, once sharp on top - so the light reads as emitted rather
 * than printed.
 *
 * ============ STATES ARE BEHAVIOUR, NOT ICONS =======================
 *
 * Each state is a shape AND a way of moving, because the shape alone is not
 * enough: open eyes that never move are a graphic, and the same open eyes
 * with small involuntary drift are attention. The movement is what makes an
 * owner read 'he is listening to me' without being told.
 *
 * listening - eyes open on you, micro-saccades, a rare blink
 * thinking  - eyes up and away, held positions, deliberate
 * speaking  - mouth animates; eyes relaxed and open
 * success   - a smile that reaches the eyes
 * attention - narrowed, amber, still
 * idle      - resting arcs, nothing moving but a slow bloom
 */
function Face({
  state,
  cx,
  eyeY,
  mouthY,
  eyeDx,
  mouthOpenness,
}: {
  state: J4State;
  cx: number;
  eyeY: number;
  mouthY: number;
  eyeDx: number;
  mouthOpenness?: number | null;
}) {
  const colour = state === "attention" ? AMBER : GREEN;
  const stroke = {
    fill: "none",
    stroke: colour,
    strokeWidth: 12,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  const L = cx - eyeDx;
  const R = cx + eyeDx;

  // THE OPEN EYE is a rounded rectangle rather than a circle: a circle reads
  // as a dot or a light, and a tall rounded shape reads as an eye even at
  // 116px, which is the only size that matters here.
  const openEye = (x: number, ry: number) => (
    <rect x={x - 13} y={eyeY - ry} width={26} height={ry * 2} rx={13} fill={colour} />
  );

  const eyes =
    state === "listening" ? (
      <g>
        {openEye(L, 19)}
        {openEye(R, 19)}
      </g>
    ) : state === "speaking" ? (
      // Slightly softer than listening: he is doing the talking now, so the
      // eyes stop being the thing asking for your attention.
      <g>
        {openEye(L, 15)}
        {openEye(R, 15)}
      </g>
    ) : state === "thinking" ? (
      // Half-lidded, looking up. The lid is a real shape rather than a
      // smaller eye, because narrowing is what reads as concentration.
      <g>
        {openEye(L, 13)}
        {openEye(R, 13)}
      </g>
    ) : state === "success" ? (
      <g {...stroke}>
        <path d={`M${L - 22} ${eyeY + 6} Q${L} ${eyeY - 20} ${L + 22} ${eyeY + 6}`} />
        <path d={`M${R - 22} ${eyeY + 6} Q${R} ${eyeY - 20} ${R + 22} ${eyeY + 6}`} />
      </g>
    ) : state === "attention" ? (
      <g {...stroke}>
        <path d={`M${L - 22} ${eyeY} h44`} />
        <path d={`M${R - 22} ${eyeY} h44`} />
      </g>
    ) : (
      // Resting: the reference's own downward arc, calm and available.
      <g {...stroke}>
        <path d={`M${L - 24} ${eyeY - 8} Q${L} ${eyeY + 16} ${L + 24} ${eyeY - 8}`} />
        <path d={`M${R - 24} ${eyeY - 8} Q${R} ${eyeY + 16} ${R + 24} ${eyeY - 8}`} />
      </g>
    );

  // THE MOUTH, AND THE SEAM FOR A REAL VOICE.
  //
  // When mouthOpenness is a number, it drives the mouth directly and no
  // animation runs - that is where a voice pipeline plugs in, per frame,
  // once one exists. Until then the speaking state uses a rhythm, which is
  // honestly a rhythm: it is not pretending to be synchronised with words
  // nobody has synthesised yet.
  const driven = typeof mouthOpenness === "number";
  const openness = driven ? Math.max(0, Math.min(1, mouthOpenness as number)) : 0;

  const mouth =
    state === "speaking" ? (
      <ellipse
        className={driven ? undefined : "j4-talk"}
        cx={cx}
        cy={mouthY}
        rx={26}
        ry={18}
        fill={colour}
        style={
          driven
            ? {
                transform: `scaleY(${0.3 + openness * 1.05})`,
                transformOrigin: `${cx}px ${mouthY}px`,
              }
            : undefined
        }
      />
    ) : state === "thinking" ? (
      // A short, off-centre line. Nothing to say yet.
      <path d={`M${cx - 16} ${mouthY} h32`} {...stroke} />
    ) : state === "listening" ? (
      // Barely there: the eyes are carrying this state, and a big smile
      // while somebody is still talking reads as not listening.
      <path d={`M${cx - 22} ${mouthY - 2} Q${cx} ${mouthY + 10} ${cx + 22} ${mouthY - 2}`} {...stroke} />
    ) : state === "attention" ? (
      <path d={`M${cx - 30} ${mouthY} h60`} {...stroke} />
    ) : state === "success" ? (
      <path d={`M${cx - 36} ${mouthY - 10} Q${cx} ${mouthY + 26} ${cx + 36} ${mouthY - 10}`} {...stroke} />
    ) : (
      <path d={`M${cx - 32} ${mouthY - 8} Q${cx} ${mouthY + 18} ${cx + 32} ${mouthY - 8}`} {...stroke} />
    );

  // HOW THE FACE MOVES. Two nested groups so the horizontal and vertical
  // drifts run on different periods and never resolve into a countable loop;
  // the blink wraps only the eyes, because a mouth does not blink.
  const drift =
    state === "listening" ? { x: "j4-lx", y: "j4-ly" } :
    state === "thinking" ? { x: "j4-ponder", y: "" } :
    { x: "", y: "" };

  return (
    <g className={drift.x || undefined}>
      <g className={drift.y || undefined}>
        <g className={state === "listening" ? "j4-blink" : undefined}>{eyes}</g>
        {mouth}
      </g>
    </g>
  );
}
