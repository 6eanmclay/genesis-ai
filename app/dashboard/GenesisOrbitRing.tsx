"use client";

import { useEffect, useId, useRef, useState } from "react";
import { GENESIS_ATMOSPHERE } from "@/lib/dashboard/genesisAtmosphere";
import { GENESIS_STATE_META, type GenesisState } from "@/lib/dashboard/genesisState";

// Saturn-ring pass (third iteration — "always alive") — two structural
// pieces stay from the first pass:
//
// 1. The ring is a tilted ellipse split into a back half (clipped to the
//    top of the viewBox, painted first) and a front half (clipped to the
//    bottom, painted last), with the planet sandwiched between them in DOM
//    order. Plain CSS stacking does the rest. The clip rects are axis-
//    aligned halves of the *outer* viewBox, so they clip in final screen
//    space regardless of the ellipse's own rotation.
//
// 2. The ring's silhouette doesn't rotate as a rigid disc — that would
//    drag the front/back split around with it and break the illusion off
//    its starting angle. The tilt stays fixed; a highlight travels *along*
//    the path instead (stroke-dashoffset) — energy flowing around a
//    stable orbit, not the orbit spinning like a wheel.
//
// New this pass — the base identity is always blue, every state, idle
// included. Genesis being "alive" is not itself a state that should ever
// visually disappear; only the *degree/kind of activity* changes. So the
// ring's own core/glow stroke (baseColor, below) never varies by state —
// only its brightness/thickness does, plus the traveling highlight and the
// planet's rim-glow shift to a real accent hue (accentColor) specifically
// when there's something genuinely needing attention (a decision, an
// opportunity, an urgent issue). idle and working both stay blue-on-blue —
// there is no real accent for either of those, only Genesis's own ongoing
// aliveness. This is the literal implementation of "state changes are
// communicated through the orbit's behavior/energy/brightness/accent, not
// by making Genesis itself appear inactive."
//
// "working" still never fakes discrete phases — it gains energy: the front
// arc's leading highlight organically ramps thicker/brighter/longer via
// genesis-energy-build-lead/-trail (globals.css), sustaining at that peak
// for however long the real request takes. The completion flourish (a
// genuine transition, caught via the previous-value ref below) briefly
// brings the whole ring to full brightness before easing back down — no
// color swap needed for that anymore, since the base was already blue.
// Breathing on the planet is unchanged, exactly as asked.
// Canonical visual reference (per direction): the "GENESIS J4" hero image.
// Two proportion/lighting corrections against it, applied below: the ring
// reads noticeably larger relative to the planet there (~2.3:1 vs. the
// ~1.8:1 this had before) — rx up, planet width down; and its brightest
// arc isn't flat blue, it has a near-white hot core inside the blue glow,
// like a real plasma filament. WHITE_CORE is that extra thin, pale layer,
// used only where the reference actually shows it (the front/brightest
// arc, and only at meaningful brightness — not on the dim back arc, not
// buried under a low-opacity idle highlight).
const FLOURISH_MS = 1300;
const WHITE_CORE = "#eef6ff";

const RING = { cx: 100, cy: 100, rx: 98, ry: 30, transform: "rotate(-18 100 100)" };

export function GenesisOrbitRing({
  state,
  glowColor,
  isStableAttention,
}: {
  state: GenesisState;
  glowColor: string;
  isStableAttention: boolean;
}) {
  const [justCompleted, setJustCompleted] = useState(false);
  const wasWorkingRef = useRef(state === "working");
  // Unique per-mount so gradient/clip/filter ids never collide if this
  // component ever renders more than once on a page.
  const uid = useId().replace(/:/g, "");

  useEffect(() => {
    const isWorkingNow = state === "working";
    if (wasWorkingRef.current && !isWorkingNow) {
      setJustCompleted(true);
      const timer = setTimeout(() => setJustCompleted(false), FLOURISH_MS);
      wasWorkingRef.current = isWorkingNow;
      return () => clearTimeout(timer);
    }
    wasWorkingRef.current = isWorkingNow;
  }, [state]);

  const isWorking = state === "working";
  // Genesis's base identity — always this blue, every state. Never swapped
  // out, only ever modulated in brightness/thickness.
  const baseColor = GENESIS_STATE_META.working.glowColor;
  // The real accent — only diverges from blue when there's something
  // genuinely needing attention. idle and working have no accent of their
  // own; they're both just Genesis, alive and blue.
  const accentColor = isStableAttention ? glowColor : baseColor;
  const coreWidth = justCompleted ? 8 : isStableAttention ? 7 : 5.5;
  const frontOpacity = justCompleted ? 1 : isStableAttention ? 0.95 : 0.8;
  const backOpacity = frontOpacity * 0.42;
  const transitionMs = justCompleted ? 150 : 800;

  const blurId = `orbit-blur-${uid}`;
  const backClipId = `orbit-clip-back-${uid}`;
  const frontClipId = `orbit-clip-front-${uid}`;

  return (
    <div className="relative aspect-square w-[78%]">
      {/* Back half of the ring — behind the planet. Same two-layer
          glow+core treatment as the front, just dimmer and thinner, the
          way a farther, receding surface reads. Always baseColor — the
          ring's own body never stops being blue. */}
      <svg viewBox="0 0 200 200" className="absolute inset-0 h-full w-full overflow-visible" aria-hidden="true">
        <defs>
          <filter id={blurId} x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="4.2" />
          </filter>
          <clipPath id={backClipId}>
            <rect x="0" y="0" width="200" height="100" />
          </clipPath>
        </defs>
        <g clipPath={`url(#${backClipId})`} style={{ transition: `opacity ${transitionMs}ms ease-out` }} opacity={backOpacity}>
          <ellipse {...RING} fill="none" stroke={baseColor} strokeWidth={coreWidth * 3} filter={`url(#${blurId})`} opacity="0.55" />
          <ellipse {...RING} fill="none" stroke={baseColor} strokeWidth={coreWidth * 0.6} opacity="0.85" />
        </g>
      </svg>

      {/* Planet — a real celestial body, lit mostly by the ring itself: a
          quiet, mostly-shadowed body with a soft rim-glow along the edge
          nearest the front (bottom) arc, plus gentle inner shading for
          roundness rather than a flat disc. The rim-glow is where the
          accent actually shows up — blue ambient light normally, a real
          accent hue when something needs attention. Breathing preserved
          exactly. */}
      <div
        aria-hidden="true"
        className="genesis-orbit-motion absolute rounded-full"
        style={{
          animation: "genesis-breathe 4.5s ease-in-out infinite",
          left: "50%",
          top: "50%",
          width: "46%",
          height: "46%",
          transform: "translate(-50%, -50%)",
          background: `radial-gradient(circle at 42% 38%, #201c34 0%, ${GENESIS_ATMOSPHERE.bgElevated} 26%, #030207 76%)`,
          boxShadow: [
            "inset -6px -8px 18px 0 rgba(0,0,0,0.6)",
            "inset 3px 4px 10px 0 rgba(255,255,255,0.04)",
            // A crisper near-edge rim-light — the ring is what's lighting
            // this part of the planet, so it reads as a defined crescent
            // rather than a soft ambient wash.
            `0 6px ${isStableAttention ? 22 : 14}px -4px ${WHITE_CORE}${isStableAttention ? "90" : "60"}`,
            `0 12px ${isStableAttention ? 40 : 26}px -6px ${accentColor}${isStableAttention ? "80" : "55"}`,
            `0 0 ${isStableAttention ? 22 : 12}px 0 ${accentColor}${isStableAttention ? "35" : "1e"}`,
          ].join(", "),
          transition: `box-shadow ${transitionMs}ms ease-out`,
        }}
      />

      {/* Front half — passes in front of the planet; brighter and thicker
          than the back arc, the way a lit, nearer surface reads. Also
          carries the continuously traveling highlight — living energy
          moving around a fixed orbit, present even at idle. The base
          strokes stay blue; the traveling highlight is where accentColor
          shows up (blue-on-blue when there's nothing to flag, a real
          accent hue when there is). */}
      <svg viewBox="0 0 200 200" className="absolute inset-0 h-full w-full overflow-visible" aria-hidden="true">
        <defs>
          <filter id={`${blurId}-f`} x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="4.6" />
          </filter>
          <clipPath id={frontClipId}>
            <rect x="0" y="100" width="200" height="100" />
          </clipPath>
        </defs>
        <g clipPath={`url(#${frontClipId})`}>
          {/* Outer bloom — wide and soft, the dramatic glow radius the
              reference has, not a tight blur hugging the stroke. */}
          <ellipse
            {...RING}
            fill="none"
            stroke={baseColor}
            strokeWidth={coreWidth * 3.4}
            filter={`url(#${blurId}-f)`}
            opacity={frontOpacity * 0.5}
            style={{ transition: `all ${transitionMs}ms ease-out` }}
          />
          {/* Blue core. */}
          <ellipse
            {...RING}
            fill="none"
            stroke={baseColor}
            strokeWidth={coreWidth}
            opacity={frontOpacity}
            style={{ transition: `all ${transitionMs}ms ease-out` }}
          />
          {/* White-hot filament — the reference's brightest arc isn't flat
              blue, it's a near-white core inside the blue glow, like a
              real plasma filament. Thin, high-opacity, only on the front
              (nearest, brightest) arc. */}
          <ellipse
            {...RING}
            fill="none"
            stroke={WHITE_CORE}
            strokeWidth={coreWidth * 0.32}
            opacity={frontOpacity * 0.9}
            style={{ transition: `all ${transitionMs}ms ease-out` }}
          />

          {isWorking ? (
            <>
              {/* Soft trailing plasma — wider, dimmer, slightly delayed
                  behind the bright leading edge. Working has no accent of
                  its own (it's Genesis's own activity, not an attention
                  signal), so this stays blue. */}
              <ellipse
                {...RING}
                fill="none"
                stroke={baseColor}
                strokeLinecap="round"
                filter={`url(#${blurId}-f)`}
                className="genesis-orbit-motion"
                style={{
                  animation:
                    "genesis-energy-build-trail 16s ease-out forwards, genesis-orbit-travel 3s linear infinite 0.15s",
                }}
              />
              {/* The bright leading edge — organically gains thickness,
                  brightness, and length the longer real work continues,
                  then holds at that peak. Never a claim about progress,
                  only about ongoing, intensifying activity. */}
              <ellipse
                {...RING}
                fill="none"
                stroke={baseColor}
                strokeLinecap="round"
                className="genesis-orbit-motion"
                style={{
                  animation: "genesis-energy-build-lead 16s ease-out forwards, genesis-orbit-travel 3s linear infinite",
                }}
              />
            </>
          ) : (
            /* Gentle continuous travel — a small highlight circulating
               along the ring at all times, softly blurred, so presence
               never reads as static even at rest. accentColor here: blue
               when idle (nothing to flag, just Genesis being alive), a
               real accent hue the moment something genuinely needs
               attention. */
            <ellipse
              {...RING}
              fill="none"
              stroke={accentColor}
              strokeWidth={isStableAttention ? 5.5 : 4.5}
              strokeLinecap="round"
              strokeDasharray={isStableAttention ? "34 380" : "20 400"}
              filter={`url(#${blurId}-f)`}
              opacity={isStableAttention ? 1 : 0.9}
              className="genesis-orbit-motion"
              style={{
                animation: `genesis-orbit-travel ${isStableAttention ? 6 : 10}s linear infinite`,
                transition: `all ${transitionMs}ms ease-out`,
              }}
            />
          )}
        </g>
      </svg>
    </div>
  );
}
