"use client";

import { useEffect, useId, useState, useSyncExternalStore } from "react";
import { GENESIS_STATE_META, type GenesisState } from "@/lib/dashboard/genesisState";
import {
  deriveActivityState,
  getGenesisActivityServerSnapshot,
  getGenesisActivitySnapshot,
  subscribeGenesisActivity,
} from "@/lib/dashboard/genesisActivity";

// Genesis's living presence for Beta, V2 — a faithfully-recreated, static
// orb (recognition: it never scales, pulses, or "breathes") with the
// living quality built entirely into the atmosphere drifting around it —
// haze, ribbons, particles, a thin edge shimmer (see app/globals.css for
// the animation system; every animated rule there is scoped to these
// atmosphere layers, none of it ever touches the orb below). Sean's own
// framing: "the environment should appear to respond to its presence,"
// never an obvious loop or a loading-spinner read.
//
// Color and activity are the same two orthogonal real signals as before,
// just now spanning the whole scene together rather than one pulsing
// core: hue is purely the real GenesisState (idle resolves to Genesis's
// own blue identity color, not a business-state hue — "blue is Genesis's
// identity, not its permanent color... when there's something meaningful
// to communicate, the entire presence transitions to that real color and
// back"); activity (idle/listening/thinking/response) only ever changes
// how fast/present the atmosphere moves, never the hue and never the
// orb's own geometry. Real isWorking/isComposing signals read from the
// shared store (lib/dashboard/genesisActivity.ts) exactly as before.
const RESPONSE_DURATION_MS = 1400; // matches globals.css's genesis-exhale duration
const IDLE_COLOR = "#6d9bff";

type VisualState = "idle" | "listening" | "thinking" | "response";

const ACTIVITY_CLASS: Record<VisualState, string> = {
  idle: "",
  listening: "genesis-activity-listening",
  thinking: "genesis-activity-thinking",
  response: "genesis-activity-response",
};

export function GenesisAvatar({
  state,
  className = "",
}: {
  state: GenesisState;
  // Caller controls sizing entirely via className (aspect-square + a
  // width, same convention every call site already used for the old
  // <Image>) — the SVG's own viewBox scaling handles everything inside
  // responsively, including the ribbon/particle paths, which is exactly
  // why they're drawn as SVG paths rather than CSS motion-path on HTML
  // elements (a fixed-unit CSS offset-path wouldn't rescale across the
  // wildly different sizes this mounts at — 44px up to ~200px).
  className?: string;
}) {
  const uid = useId();
  const activity = useSyncExternalStore(
    subscribeGenesisActivity,
    getGenesisActivitySnapshot,
    getGenesisActivityServerSnapshot
  );
  const activityState = deriveActivityState(activity);

  // Response is a one-shot local phase, not shared external state — each
  // mounted instance independently detects the real isWorking true->false
  // edge and plays its own. React's documented "adjusting state when a
  // value changes" pattern (useState-tracked previous value compared
  // during render, not a ref — refs can't be read/written during render,
  // see react-hooks/refs), same as this codebase's other two uses of it
  // this milestone (arrivalBeats.ts, DashboardShell.tsx's isFreshLaunch).
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
  const color = state === "idle" ? IDLE_COLOR : GENESIS_STATE_META[state].glowColor;

  const coreGradientId = `genesis-core-${uid}`;
  const sphereGradientId = `genesis-sphere-${uid}`;

  return (
    <div className={`relative ${ACTIVITY_CLASS[visualState]} ${className}`}>
      {/* Haze — the primary "inhale/exhale" carrier, plain blurred CSS
          divs so they scale correctly via percentage insets regardless of
          this instance's actual pixel size. */}
      <div
        aria-hidden="true"
        className="genesis-haze absolute inset-[-55%] rounded-full blur-3xl transition-colors duration-1000"
        style={{ backgroundColor: color, opacity: 0.22 }}
      />
      <div
        aria-hidden="true"
        className="genesis-haze absolute inset-[-30%] rounded-full blur-2xl transition-colors duration-1000"
        style={{ backgroundColor: color, opacity: 0.16, animationDelay: "-6s" }}
      />

      {/* Ground reflection, matching the reference's soft glow beneath the
          orb — static, no animation. */}
      <div
        aria-hidden="true"
        className="absolute top-[92%] left-1/2 h-[18%] w-[55%] -translate-x-1/2 rounded-full blur-xl transition-colors duration-1000"
        style={{ backgroundColor: color, opacity: 0.35 }}
      />

      <svg
        viewBox="0 0 200 200"
        className="absolute inset-0 h-full w-full transition-colors duration-1000"
        style={{ overflow: "visible", color }}
        aria-hidden="true"
      >
        <defs>
          <radialGradient id={coreGradientId} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="45%" stopColor="currentColor" stopOpacity="0.9" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </radialGradient>
          <radialGradient id={sphereGradientId} cx="50%" cy="40%" r="62%">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.32" />
            <stop offset="70%" stopColor="currentColor" stopOpacity="0.08" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* Ribbons — soft drifting streaks along curved paths, drawn behind
            the orb. A moving stroke-dasharray segment along an invisible
            path (pathLength="1" normalizes the dash math to the path's own
            length, see globals.css's genesis-flow), not a literal moving
            object — the well-supported, responsive-safe way to get "light
            flowing along a curve" purely in CSS/SVG. */}
        <path
          d="M 14,146 C 46,58 154,58 186,104"
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.28"
          strokeWidth="1.6"
          strokeLinecap="round"
          pathLength="1"
          strokeDasharray="0.22 0.78"
          className="genesis-ribbon"
        />
        <path
          d="M 12,62 C 66,166 134,166 188,86"
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.2"
          strokeWidth="1.4"
          strokeLinecap="round"
          pathLength="1"
          strokeDasharray="0.18 0.82"
          className="genesis-ribbon"
          style={{ animationDelay: "-9s", animationDirection: "reverse" }}
        />

        {/* Particles — tiny round-capped dots drifting along their own
            wider loop around the orb, same technique as the ribbons above,
            just a much shorter dash so each reads as a single mote rather
            than a streak. */}
        <path
          d="M 24,100 C 24,46 176,46 176,100 C 176,154 24,154 24,100 Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          pathLength="1"
          strokeDasharray="0.02 0.98"
          className="genesis-particle"
          opacity="0.7"
        />
        <path
          d="M 24,100 C 24,46 176,46 176,100 C 176,154 24,154 24,100 Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          pathLength="1"
          strokeDasharray="0.015 0.985"
          className="genesis-particle"
          opacity="0.5"
          style={{ animationDelay: "-6s", animationDirection: "reverse" }}
        />
        <path
          d="M 100,8 C 172,26 192,100 172,174 C 100,192 28,174 8,100 C 28,26 100,8 100,8 Z"
          fill="none"
          stroke="#ffffff"
          strokeWidth="1.8"
          strokeLinecap="round"
          pathLength="1"
          strokeDasharray="0.015 0.985"
          className="genesis-particle"
          opacity="0.55"
          style={{ animationDelay: "-11s" }}
        />

        {/* The orb — static artwork, faithfully recreated: a translucent
            sphere, three crossing orbital rings, a scattering of sparkle
            points, and a bright core. Nothing below this line is ever
            animated by anything in globals.css. */}
        <circle cx="100" cy="100" r="66" fill={`url(#${sphereGradientId})`} stroke="currentColor" strokeOpacity="0.32" strokeWidth="1" />
        <ellipse cx="100" cy="100" rx="88" ry="30" transform="rotate(-18 100 100)" fill="none" stroke="currentColor" strokeOpacity="0.5" strokeWidth="1.2" />
        <ellipse cx="100" cy="100" rx="88" ry="30" transform="rotate(55 100 100)" fill="none" stroke="currentColor" strokeOpacity="0.32" strokeWidth="1" />
        <ellipse cx="100" cy="100" rx="88" ry="30" transform="rotate(122 100 100)" fill="none" stroke="currentColor" strokeOpacity="0.4" strokeWidth="1" />

        <circle cx="184" cy="100" r="1.5" fill="currentColor" opacity="0.9" />
        <circle cx="157" cy="41" r="1" fill="#ffffff" opacity="0.85" />
        <circle cx="100" cy="16" r="1.3" fill="currentColor" opacity="0.7" />
        <circle cx="43" cy="44" r="1" fill="#ffffff" opacity="0.6" />
        <circle cx="16" cy="103" r="1.4" fill="currentColor" opacity="0.85" />
        <circle cx="47" cy="159" r="1" fill="#ffffff" opacity="0.7" />
        <circle cx="103" cy="184" r="1.3" fill="currentColor" opacity="0.6" />
        <circle cx="159" cy="156" r="1" fill="#ffffff" opacity="0.8" />

        {/* Edge shimmer — the one motion element allowed right at the
            orb's own boundary, deliberately the slowest and subtlest of
            everything here. */}
        <circle
          cx="100"
          cy="100"
          r="68"
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.45"
          strokeWidth="1"
          strokeLinecap="round"
          pathLength="1"
          strokeDasharray="0.05 0.95"
          className="genesis-shimmer"
        />

        <circle cx="100" cy="100" r="24" fill={`url(#${coreGradientId})`} />
        <circle cx="100" cy="100" r="6.5" fill="#ffffff" />
      </svg>
    </div>
  );
}
