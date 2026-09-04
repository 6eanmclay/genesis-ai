"use client";

// J4, DRAWN (2026-09-03).
//
// ============ WHY THIS IS SVG AND NOT THE PHOTOGRAPH ================
//
// The approved direction asks for a character who can look attentive,
// thoughtful, speaking or pleased. `GenesisAvatar` renders ONE IMAGE OF ONE
// POSE, so every expression was blocked on an asset commission — and the
// recorded prior art is that gpt-image-1 could not preserve locked regions,
// which is exactly what an expression matrix needs.
//
// Drawing him solves that rather than waiting it out. The eyes and mouth are
// shapes this file controls, so a state is a different `d` attribute instead of
// a different file; it is resolution-independent, so the 16px case and the
// expanded case are the same component; and the locked regions the
// specification names — silhouette, visor, ear disc, frame — are locked because
// they are literally the same path every time.
//
// ASSUMPTION, STATED: this is a real implementation, not the final art. When
// the commissioned character arrives it replaces the drawn one behind this same
// component API, and nothing that consumes J4 changes. Sean asked to see and
// critique the actual thing rather than approve another specification.
//
// ============ GREEN IS J4, BLUE IS GENESIS ==========================
//
// Every colour here is J4's own. Nothing borrows the Genesis blue, which stays
// the platform's.

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

const GREEN = "#4ade3a";
const GREEN_DIM = "#2f9d26";

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
  /** Accessible name. Omitted where a parent already labels him. */
  title?: string;
}) {
  // The helmet is the only thing a skin changes. Face, frame and glow are J4's
  // identity and are the same in both — "choose your J4", not "a different J4".
  const shell = skin === "light" ? "#f4f6f7" : "#1c1f22";
  const shellEdge = skin === "light" ? "#cfd6da" : "#0d0f11";

  // Eyes shift a few units rather than the head turning. At 32px a rotating
  // head is mush; a moved pupil still reads.
  const gazeX = gaze === "left" ? -5 : gaze === "right" ? 5 : 0;
  const gazeY = gaze === "down" ? 4 : 0;

  const speaking = state === "speaking";
  const uid = `j4-${state}-${skin}`;

  return (
    <svg
      viewBox="0 0 120 120"
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
        <radialGradient id={`${uid}-glow`}>
          <stop offset="55%" stopColor={GREEN} stopOpacity="0.30" />
          <stop offset="100%" stopColor={GREEN} stopOpacity="0" />
        </radialGradient>
        <pattern id={`${uid}-comb`} width="14" height="12" patternUnits="userSpaceOnUse">
          {/* RESTRAINED, as the direction insists: a texture you notice only
              when you look for it, never the old sonar bloom. */}
          <path
            d="M7 0 L14 3.5 L14 8.5 L7 12 L0 8.5 L0 3.5 Z"
            fill="none"
            stroke={GREEN}
            strokeOpacity="0.16"
            strokeWidth="0.8"
          />
        </pattern>
        <clipPath id={`${uid}-disc`}>
          <circle cx="60" cy="60" r="54" />
        </clipPath>
      </defs>

      <style>{`
        @keyframes j4-breathe { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-1.5px) } }
        @keyframes j4-pulse   { 0%,100% { opacity: .45 } 50% { opacity: 1 } }
        @keyframes j4-spin    { to { transform: rotate(360deg) } }
        @keyframes j4-talk    { 0%,100% { transform: scaleY(.45) } 50% { transform: scaleY(1.25) } }
        @keyframes j4-nudge   { 0%,100% { transform: translateY(0) } 25% { transform: translateY(-2.5px) } 60% { transform: translateY(0) } }
        .j4-body   { animation: j4-breathe 4.5s ease-in-out infinite; transform-origin: 60px 60px }
        .j4-ring   { transform-origin: 60px 60px }
        .j4-listen { animation: j4-pulse 1.5s ease-in-out infinite }
        .j4-think  { animation: j4-spin 2.6s linear infinite; transform-origin: 60px 60px }
        .j4-mouth-talk { animation: j4-talk .28s ease-in-out infinite; transform-origin: 60px 74px }
        .j4-attention  { animation: j4-nudge 2.2s ease-in-out infinite; transform-origin: 60px 60px }
        @media (prefers-reduced-motion: reduce) {
          .j4-body, .j4-listen, .j4-think, .j4-mouth-talk, .j4-attention { animation: none }
        }
      `}</style>

      {/* ---- the environment: frame, honeycomb, glow --------------------- */}
      <circle cx="60" cy="60" r="54" fill={skin === "light" ? "#0e1211" : "#0a0c0b"} />
      <g clipPath={`url(#${uid}-disc)`}>
        <rect x="0" y="0" width="120" height="120" fill={`url(#${uid}-comb)`} />
        <circle cx="60" cy="62" r="46" fill={`url(#${uid}-glow)`} />
      </g>

      <circle
        className={`j4-ring ${state === "listening" ? "j4-listen" : ""} ${state === "attention" ? "j4-attention" : ""}`}
        cx="60"
        cy="60"
        r="54"
        fill="none"
        stroke={state === "attention" ? "#ffd24a" : GREEN}
        strokeWidth={state === "listening" || state === "attention" ? 4 : 3}
      />

      {/* THINKING IS THE FRAME'S JOB, not the face's — a character who pulls a
          face while working looks stuck rather than busy. */}
      {state === "thinking" && (
        <circle
          className="j4-think"
          cx="60"
          cy="60"
          r="54"
          fill="none"
          stroke={GREEN}
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray="26 315"
        />
      )}

      <g className={state === "attention" ? "j4-attention" : "j4-body"}>
        {/* ---- shoulders ------------------------------------------------- */}
        <path d="M30 108 Q60 88 90 108 L90 114 L30 114 Z" fill={shell} stroke={shellEdge} strokeWidth="1.2" />
        <path d="M52 100 h16 v5 h-16 z" fill={GREEN} opacity="0.85" />

        {/* ---- head shell: the silhouette that must never change ---------- */}
        <path
          d="M60 22 C81 22 95 37 95 57 C95 76 81 90 60 90 C39 90 25 76 25 57 C25 37 39 22 60 22 Z"
          fill={shell}
          stroke={shellEdge}
          strokeWidth="1.4"
        />
        {/* crest */}
        <path d="M60 22 C68 22 74 25 78 29 L74 34 C70 31 66 30 60 30 Z" fill={shellEdge} opacity="0.55" />

        {/* ---- ear discs, one carrying the wordmark ---------------------- */}
        <circle cx="25" cy="58" r="10" fill={shell} stroke={shellEdge} strokeWidth="1.2" />
        <circle cx="25" cy="58" r="6" fill="none" stroke={GREEN} strokeWidth="1.6" />
        <text x="25" y="61" textAnchor="middle" fontSize="6.5" fontWeight="700" fill={GREEN}>J4</text>
        <circle cx="95" cy="58" r="10" fill={shell} stroke={shellEdge} strokeWidth="1.2" />
        <circle cx="95" cy="58" r="6" fill="none" stroke={GREEN_DIM} strokeWidth="1.6" />

        {/* ---- visor: the dark face the expressions live on -------------- */}
        <path
          d="M60 32 C76 32 86 42 86 57 C86 72 76 82 60 82 C44 82 34 72 34 57 C34 42 44 32 60 32 Z"
          fill="#080b0a"
        />

        <g transform={`translate(${gazeX} ${gazeY})`}>
          <Eyes state={state} />
          <Mouth state={state} speaking={speaking} />
        </g>
      </g>
    </svg>
  );
}

/**
 * The eyes carry most of the state, because they are what a person reads first
 * and what still resolves when J4 is 32px across.
 */
function Eyes({ state }: { state: J4State }) {
  const glow = { fill: "none", stroke: GREEN, strokeWidth: 4.5, strokeLinecap: "round" as const };

  // Wide open: attentive. The only state where the eyes are circles, so
  // "listening" is unmistakable at a glance.
  if (state === "listening") {
    return (
      <g>
        <circle cx="49" cy="55" r="4.6" fill={GREEN} />
        <circle cx="71" cy="55" r="4.6" fill={GREEN} />
      </g>
    );
  }

  // Pleased: arcs turned up. Read as a smile even before the mouth is seen.
  if (state === "success") {
    return (
      <g {...glow}>
        <path d="M44 57 Q49 50 54 57" />
        <path d="M66 57 Q71 50 76 57" />
      </g>
    );
  }

  // Considering: half-lidded and looking slightly up.
  if (state === "thinking") {
    return (
      <g {...glow}>
        <path d="M44 54 Q49 51 54 54" />
        <path d="M66 54 Q71 51 76 54" />
      </g>
    );
  }

  // Idle, speaking, attention: the resting eye — a soft downward arc, which is
  // the shape the concept art reads as "friendly, not staring".
  return (
    <g {...glow}>
      <path d="M44 53 Q49 60 54 53" />
      <path d="M66 53 Q71 60 76 53" />
    </g>
  );
}

/**
 * The mouth. Two frames when speaking, which the specification names as the
 * minimum viable approach — a viseme set needs voice timing that does not exist
 * yet, and a flap reads correctly at every size this is drawn at.
 */
function Mouth({ state, speaking }: { state: J4State; speaking: boolean }) {
  if (speaking) {
    return (
      <ellipse className="j4-mouth-talk" cx="60" cy="72" rx="7" ry="5" fill={GREEN} />
    );
  }
  if (state === "success") {
    return <path d="M50 69 Q60 80 70 69" fill="none" stroke={GREEN} strokeWidth="4" strokeLinecap="round" />;
  }
  if (state === "attention") {
    // Neither smiling nor alarmed: a straight, attentive line.
    return <path d="M52 72 h16" fill="none" stroke={GREEN} strokeWidth="4" strokeLinecap="round" />;
  }
  return <path d="M52 70 Q60 76 68 70" fill="none" stroke={GREEN} strokeWidth="3.6" strokeLinecap="round" />;
}
