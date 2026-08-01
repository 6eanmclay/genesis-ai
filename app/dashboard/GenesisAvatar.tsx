"use client";

import Image from "next/image";
import { useEffect, useState, useSyncExternalStore } from "react";
import { GENESIS_STATE_META, type GenesisState } from "@/lib/dashboard/genesisState";
import {
  deriveActivityState,
  getGenesisActivityServerSnapshot,
  getGenesisActivitySnapshot,
  subscribeGenesisActivity,
} from "@/lib/dashboard/genesisActivity";

// Genesis's living presence for Beta, V3 — Sean's real reference photo
// (public/brand/genesis-avatar-orb.png, the actual file, not a
// recreation) is the dominant layer, ~85-90% of what's seen. Everything
// below only adds a light, mostly-invisible atmosphere around/behind it —
// it must never compete with or replace the photo. "The final result
// should immediately look like the original Genesis artwork, but after
// watching for a few seconds, users notice that the environment is
// quietly alive."
//
// The photo's own black background is rendered with mix-blend-mode:
// screen (not object-fit alone) specifically so it never shows as a hard
// rectangle — screen-blended black contributes nothing to the composite,
// so it vanishes into whatever's behind it (every real mount site here is
// already the same dark Genesis atmosphere background), while the photo's
// own bright glow blends additively with the haze/ribbons behind it.
//
// Color and activity are the same two orthogonal real signals as before:
// hue is purely the real GenesisState (idle leaves the photo's own
// natural blue untouched — zero hue-rotate — everything else rotates
// toward the real state's actual hue via a CSS filter, since a real photo
// can't be recolored by swapping a fill value the way the hand-drawn
// version could); activity (idle/listening/thinking/response) only ever
// changes how present the atmosphere is, never the photo's own hue and
// never its geometry. Real isWorking/isComposing signals read from the
// shared store (lib/dashboard/genesisActivity.ts) exactly as before.
const RESPONSE_DURATION_MS = 1400; // matches globals.css's genesis-exhale duration

// "Waking up" — an opt-in one-shot mount phase for the full-screen arrival
// moment only (GenesisArrivalOverlay.tsx passes wakeOnMount; the persistent
// rail/toolbar mounts never do — they're chrome, not a ritual, and
// shouldn't replay a wake-up every time they render). Sean's explicit ask
// after seeing the ritual at full speed: "don't have it already fully
// energized. Let it start as a dim, quiet glow. Over the first second or
// two, let the light intensify, the orbitals begin moving, and the energy
// build naturally — as if Genesis is literally waking up because you
// arrived." WAKE_DURATION_MS is deliberately the value genesisArrivalCopy.ts
// sizes its first beat's pauseBeforeMs against, so the greeting text lands
// right as the orb finishes waking.
const WAKE_DURATION_MS = 1700;

// The photo's own dominant hue — measured against its actual blue, not a
// guess — so idle (hueRotate === 0) shows the reference exactly as shot,
// and every other state's rotation is computed relative to real ground
// truth rather than hardcoded per-state degrees that could silently drift
// from GENESIS_STATE_META if that palette ever changes.
const SOURCE_IMAGE_HUE = hexHue("#6d9bff");

function hexHue(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return 0;
  let hue: number;
  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  hue *= 60;
  return hue < 0 ? hue + 360 : hue;
}

type VisualState = "idle" | "listening" | "thinking" | "response";

const ACTIVITY_CLASS: Record<VisualState, string> = {
  idle: "",
  listening: "genesis-activity-listening",
  thinking: "genesis-activity-thinking",
  response: "genesis-activity-response",
};

// Canonical identity polish pass (2026-08-01) — the orbital system itself
// (the two ellipses' rx/ry/rotation, the comet trails riding them) is
// frozen by explicit instruction and untouched below. These two new
// transient layers ride the SAME two orbit paths / a spread of fixed
// points rather than introducing any new geometry, so "preserve the
// orbital system exactly" holds even though the field now has more going
// on inside it. Every duration/delay pair below is a deliberately
// uncommon, mutually-prime-ish number so the combined system's real
// repeat period is on the order of hours, not seconds — "never appears
// to repeat exactly."
//
// Shooting stars — reuse the two existing invisible orbit paths, but
// spend most of their cycle motionless and invisible, then travel only a
// short arc before fading (see the genesis-shooting-star keyframe) —
// "spontaneous bursts," never a third permanent orbiter.
const SHOOTING_STARS: { rx: number; ry: number; rotate: number; duration: number; delay: number }[] = [
  { rx: 76, ry: 26, rotate: -18, duration: 8.7, delay: -1.4 },
  { rx: 76, ry: 26, rotate: -18, duration: 12.3, delay: -6.8 },
  { rx: 68, ry: 23, rotate: 58, duration: 10.6, delay: -3.9 },
];

// Ambient sparks — fixed points (no orbit motion at all), spread at
// angles the two ribbon lanes don't already occupy, so the quieter
// regions of the field still feel inhabited without adding permanent
// density. Coordinates are cos/sin at varied angle+radius, computed once
// and hardcoded, matching this file's existing convention of hand-placed
// SVG geometry rather than runtime trig.
const AMBIENT_SPARKS: { x: number; y: number; duration: number; delay: number }[] = [
  { x: 159.9, y: 116.0, duration: 9.4, delay: -1.1 },
  { x: 94.9, y: 157.8, duration: 11.8, delay: -5.3 },
  { x: 35.0, y: 111.5, duration: 14.2, delay: -8.7 },
  { x: 69.0, y: 55.8, duration: 10.6, delay: -2.4 },
  { x: 134.4, y: 50.9, duration: 13.1, delay: -6.0 },
];

export function GenesisAvatar({
  state,
  className = "",
  wakeOnMount = false,
}: {
  state: GenesisState;
  // Caller controls sizing entirely via className (aspect-square + a
  // width), same convention every call site already used before.
  className?: string;
  // Opt-in: start dim and still, then ramp up to full presence over
  // WAKE_DURATION_MS. Only the full-screen arrival overlay sets this.
  wakeOnMount?: boolean;
}) {
  const activity = useSyncExternalStore(
    subscribeGenesisActivity,
    getGenesisActivitySnapshot,
    getGenesisActivityServerSnapshot
  );
  const activityState = deriveActivityState(activity);

  // One-shot local phase, same "start true, flip once via a mount effect"
  // shape as the rest of this component's local state — never re-triggers
  // on prop changes, only on this instance's own real mount. Commits the
  // dim/stopped style on the first paint, then flips on the very next
  // frame — the CSS transition (WAKE_DURATION_MS, set alongside each
  // dimmed property below) is what actually carries the whole ramp, so
  // brightness genuinely climbs for the full ~1.7s starting at mount,
  // instead of holding flat-dim and only then snapping bright.
  const [waking, setWaking] = useState(wakeOnMount);
  useEffect(() => {
    if (!waking) return;
    const raf = requestAnimationFrame(() => setWaking(false));
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Response is a one-shot local phase, not shared external state — each
  // mounted instance independently detects the real isWorking true->false
  // edge and plays its own. React's documented "adjusting state when a
  // value changes" pattern (useState-tracked previous value compared
  // during render, not a ref — refs can't be read/written during render,
  // see react-hooks/refs).
  const [responding, setResponding] = useState(false);
  const [prevWorking, setPrevWorking] = useState(activity.isWorking);
  if (activity.isWorking !== prevWorking) {
    const wasWorking = prevWorking;
    setPrevWorking(activity.isWorking);
    if (wasWorking && !activity.isWorking) {
      setResponding(true);
    }
  }
  useEffect(() => {
    if (!responding) return;
    const timer = setTimeout(() => setResponding(false), RESPONSE_DURATION_MS);
    return () => clearTimeout(timer);
  }, [responding]);

  const visualState: VisualState = responding ? "response" : activityState;
  const color = state === "idle" ? "#6d9bff" : GENESIS_STATE_META[state].glowColor;
  const hueRotateDeg = state === "idle" ? 0 : hexHue(color) - SOURCE_IMAGE_HUE;

  return (
    <div
      className={`relative ${waking ? "genesis-avatar-dormant" : ""} ${ACTIVITY_CLASS[visualState]} ${className}`}
    >
      {/* A dark backdrop wash, always rendered regardless of the host
          page's own background — mix-blend-mode: screen below only
          produces visible glow against something dark behind it (every
          other mount site is already Genesis's own dark atmosphere, but
          the two small toolbar-icon spots in DashboardShell.tsx sit on a
          plain white card; without this, the whole avatar nearly vanished
          there — confirmed by screenshot). Blurred and faded fully to
          transparent (not a flat-opaque disc with a hard rounded-full
          edge, which is what this used to be) — at the arrival overlay's
          much larger real size, that old crisp edge became exactly the
          "visible circular boundary" Sean flagged. This now feathers out
          the same way the photo's own mask does below, so there's no
          radius at which either one draws a hard line. */}
      <div
        aria-hidden="true"
        className="absolute inset-[-20%] rounded-full blur-2xl"
        style={{
          background: "radial-gradient(circle, #12101f 0%, #0a0812 38%, rgba(10,8,18,0.4) 55%, transparent 75%)",
        }}
      />

      {/* Haze — a soft background wash extending the photo's own glow
          outward past its frame, so the transition from photo to
          surrounding UI never reads as a hard edge. Kept faint — this is
          the one atmosphere layer allowed behind the photo. Dims further
          during the wake ramp (see the Image's filter comment below for the
          full "waking up" rationale) — a plain opacity multiplier composites
          correctly under any child regardless of how that child sets its
          own opacity, so this doesn't fight the particles' own inline
          opacity values below. */}
      <div
        aria-hidden="true"
        className="genesis-haze absolute inset-[-45%] rounded-full blur-3xl transition-all"
        style={{ backgroundColor: color, opacity: (waking ? 0.3 : 1) * 0.16, transitionDuration: `${WAKE_DURATION_MS}ms` }}
      />

      {/* A very subtle, slow, irregular brightness flicker at the core —
          one real "tiny brightness fluctuation" contributing to the
          non-repeating feel Sean asked for. Its own independent layer,
          never touching .genesis-haze's already-verified drift/exhale/
          dormant animations — see genesis-flicker in globals.css for why
          it uses uneven keyframe spacing rather than a clean sine wave. */}
      <div
        aria-hidden="true"
        className="genesis-flicker absolute inset-[15%] rounded-full blur-2xl"
        style={{ backgroundColor: color, mixBlendMode: "screen" }}
      />

      {/* The real reference photo — the dominant layer. mix-blend-mode:
          screen makes its solid black background vanish into the (always
          dark) surface behind it instead of showing as a rectangle; the
          bright orb blends additively with the haze/atmosphere around it
          instead of sitting flatly on top. hue-rotate is the only real
          per-state color change — 0deg at idle leaves the photo exactly
          as shot. brightness ramps from a dim, quiet 0.35 up to its normal
          1.15 across WAKE_DURATION_MS when wakeOnMount is set — the core
          itself is baked into the photo, so dimming brightness dims the
          whole orb, not just the atmosphere around it. The ramp starts
          essentially at mount (waking flips false on the very next frame,
          not after a real delay) so this CSS transition is what actually
          carries the "over the first second or two, let the light
          intensify" build, rather than holding flat-dim and snapping. */}
      <Image
        src="/brand/genesis-avatar-orb.png"
        alt="Genesis"
        fill
        sizes="(min-width: 1024px) 440px, 75vw"
        className="object-contain transition-[filter]"
        style={{
          mixBlendMode: "screen",
          transitionDuration: `${WAKE_DURATION_MS}ms`,
          filter: `brightness(${waking ? 0.35 : 1.15}) saturate(${state === "idle" ? 1 : 1.2}) hue-rotate(${hueRotateDeg}deg)`,
          // The source photo (546x350, landscape) isn't perfectly square
          // and its "black" background is a few RGB values above zero
          // (confirmed by sampling) — object-contain's letterboxing plus
          // that residual color shows as a faint rectangle under
          // mix-blend-mode alone. A radial alpha mask fades the image's
          // own edges to fully transparent, guaranteeing no visible
          // boundary. A long, multi-stop taper (not the old 2-stop
          // 48%->78% fade) — at the arrival overlay's much larger real
          // size, that shorter fade was visible as a soft-edged circle;
          // this one settles to fully transparent well before the box's
          // own edge, matching the backdrop wash's own fade above so
          // neither layer draws a perceptible line.
          WebkitMaskImage:
            "radial-gradient(circle, black 0%, black 32%, rgba(0,0,0,0.65) 48%, rgba(0,0,0,0.25) 64%, transparent 84%)",
          maskImage:
            "radial-gradient(circle, black 0%, black 32%, rgba(0,0,0,0.65) 48%, rgba(0,0,0,0.25) 64%, transparent 84%)",
        }}
      />

      {/* Atmosphere overlay — ribbons and particles only (the moving
          highlights), lightly blended on top of the photo, never a
          second static ring/sparkle system competing with the real ones
          already visible in the photo itself. Sean's explicit framing:
          "lightly blended on top — not replace it." Faded out and its
          ribbons/particles/shimmer held motionless for their first frame
          (via the genesis-avatar-dormant class on the root above, which
          pauses their animation-name — see globals.css) so they genuinely
          start their loop at mount rather than resuming mid-cycle, then
          fade in alongside the same wake ramp as everything else. */}
      <svg
        viewBox="0 0 200 200"
        className="absolute inset-0 h-full w-full transition-all"
        style={{
          overflow: "visible",
          color,
          mixBlendMode: "screen",
          opacity: waking ? 0.12 : 1,
          transitionDuration: `${WAKE_DURATION_MS}ms`,
        }}
        aria-hidden="true"
      >
        {/* Two orbits, tightly matched to the rings already visible in the
            photo (rx/ry well inside the mask's fade radius, never near the
            frame edge) — a ribbon and a comet share each orbit so they
            read as one energy system per lane, not unrelated effects.
            Ellipses support pathLength/dasharray the same as <path> in
            every modern browser, so no bezier approximation is needed.
            Frozen geometry: rx/ry/rotation are the canonical orbital
            system and stay exactly as shipped — only timing changed
            below (one dominant direction now, distinct durations per
            lane so the two never move in lockstep). */}
        <ellipse
          cx="100"
          cy="100"
          rx="76"
          ry="26"
          transform="rotate(-18 100 100)"
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.26"
          strokeWidth="1.3"
          strokeLinecap="round"
          pathLength="1"
          strokeDasharray="0.15 0.85"
          className="genesis-ribbon"
        />
        <ellipse
          cx="100"
          cy="100"
          rx="68"
          ry="23"
          transform="rotate(58 100 100)"
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.2"
          strokeWidth="1.2"
          strokeLinecap="round"
          pathLength="1"
          strokeDasharray="0.13 0.87"
          className="genesis-ribbon"
          style={{ animationDuration: "29s", animationDelay: "-9s" }}
        />

        {/* Comets — a tiny bright lead point plus two shrinking, fading
            points close behind it on the same orbit, all moving together
            (one shared animation, staggered only by a small negative
            delay) so they read as a single streaking spark with a trail,
            never a scattered dash. Deliberately small and few — "less is
            more." Both lanes now share one dominant direction ("the
            overwhelming majority... one coherent energy field") — comet B
            previously ran reverse; a distinct duration (14.5s vs A's 13s)
            keeps the two lanes from ever feeling synchronized without
            resorting to opposite motion. */}
        {[0, 1, 2].map((i) => (
          <ellipse
            key={`comet-a-${i}`}
            cx="100"
            cy="100"
            rx="76"
            ry="26"
            transform="rotate(-18 100 100)"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.1 - i * 0.2}
            strokeLinecap="round"
            pathLength="1"
            strokeDasharray="0.006 0.994"
            className="genesis-particle"
            opacity={0.85 - i * 0.32}
            style={i > 0 ? { animationDelay: `-${i * 0.35}s` } : undefined}
          />
        ))}
        {[0, 1, 2].map((i) => (
          <ellipse
            key={`comet-b-${i}`}
            cx="100"
            cy="100"
            rx="68"
            ry="23"
            transform="rotate(58 100 100)"
            fill="none"
            stroke="#ffffff"
            strokeWidth={1 - i * 0.18}
            strokeLinecap="round"
            pathLength="1"
            strokeDasharray="0.006 0.994"
            className="genesis-particle"
            opacity={0.7 - i * 0.26}
            style={{ animationDuration: "14.5s", animationDelay: `-${6 + i * 0.35}s` }}
          />
        ))}

        {/* Shooting stars — short-lived bursts riding the same two orbit
            paths above; see genesis-shooting-star in globals.css and the
            SHOOTING_STARS config comment for the full reasoning. Each is
            a lead point plus one softer, slightly-lagging trail point, a
            lighter version of the comet trail technique above. */}
        {SHOOTING_STARS.map((s, i) => (
          <g key={`shooting-star-${i}`}>
            <ellipse
              cx="100"
              cy="100"
              rx={s.rx}
              ry={s.ry}
              transform={`rotate(${s.rotate} 100 100)`}
              fill="none"
              stroke="#ffffff"
              strokeWidth="1.3"
              strokeLinecap="round"
              pathLength="1"
              strokeDasharray="0.012 0.988"
              className="genesis-shooting-star"
              style={{ animationDuration: `${s.duration}s`, animationDelay: `${s.delay}s` }}
            />
            <ellipse
              cx="100"
              cy="100"
              rx={s.rx}
              ry={s.ry}
              transform={`rotate(${s.rotate} 100 100)`}
              fill="none"
              stroke="#ffffff"
              strokeWidth="0.7"
              strokeLinecap="round"
              pathLength="1"
              strokeDasharray="0.012 0.988"
              opacity={0.5}
              className="genesis-shooting-star"
              style={{ animationDuration: `${s.duration}s`, animationDelay: `${s.delay - 0.15}s` }}
            />
          </g>
        ))}

        {/* Ambient sparks — tiny fixed points of light with no orbit
            motion at all, spread at angles the two ribbon lanes don't
            already occupy; see genesis-spark in globals.css and the
            AMBIENT_SPARKS config comment. */}
        {AMBIENT_SPARKS.map((s, i) => (
          <circle
            key={`spark-${i}`}
            cx={s.x}
            cy={s.y}
            r="1.1"
            fill="#ffffff"
            className="genesis-spark"
            style={{ animationDuration: `${s.duration}s`, animationDelay: `${s.delay}s` }}
          />
        ))}

        {/* Edge shimmer — the one motion element right at the photo's own
            orb boundary, deliberately the slowest and subtlest here. */}
        <circle
          cx="100"
          cy="100"
          r="68"
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.2"
          strokeWidth="1"
          strokeLinecap="round"
          pathLength="1"
          strokeDasharray="0.05 0.95"
          className="genesis-shimmer"
        />
      </svg>
    </div>
  );
}
