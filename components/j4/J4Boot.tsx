"use client";

import { useEffect, useRef, useState } from "react";

// J4 BRINGS THE BUSINESS ONLINE (2026-09-04).
//
// The opening is a sequence, not a loading screen, and the difference is that
// every beat means something: J4 arrives, wakes, switches six real areas of
// Genesis on one at a time, and tells the owner it is done. A spinner says the
// system is busy. This says what the system is doing.
//
// THE ARTWORK CARRIES THE POSE; THE COMPONENT CARRIES THE LIGHT. The base is
// Sean's storyboard frame with J4 off - blank visor, thumb already raised, the
// six icons baked in as lit. So the icons are switched on by UNCOVERING them:
// each starts under a dark patch that lifts on cue, which means the activation
// reveals the real artwork rather than drawing a substitute over it.
//
// EVERYTHING IS IN ONE TIMELINE, below, because this will be tuned by eye and
// tuning should not mean hunting through JSX for numbers.

/**
 * TWO FRAMES OF THE SAME ARTWORK, both supplied by Sean.
 *
 * OFF is the source of truth for the starting state: his own edit, with the
 * six system icons already grey. ON is the same composition with them lit.
 * Activating a system cross-fades that ONE icon's circle from OFF to ON.
 *
 * NOTHING IS MANIPULATED IN CODE. An earlier version desaturated the lit
 * icons at runtime to fake an off state, which meant the product was showing
 * a filter's idea of "off" rather than the artist's. Both frames are now his,
 * and the code only decides which one shows where.
 *
 * They are normalised to the same square framing (ring bounding box, padded),
 * which is what lets one set of coordinates address both.
 */
const ART_OFF = "/brand/j4-off.png";
const ART_ON = "/brand/j4-icons-on.png";
/** The illuminated face, as a transparent layer over ART_OFF. */
const ART_FACE = "/brand/j4-face-on.png";

/** Every duration in the opening, in milliseconds. Tune here, nowhere else. */
export const BOOT_TIMELINE = {
  /** One clean rotation - long enough to glimpse him without seeing him. */
  flip: 1900,
  /** He has stopped. A beat of stillness before anything happens. */
  settle: 420,
  /** The eyes coming up. */
  wake: 520,
  /** How long one system takes to come up. */
  power: 380,
  /** Between one system and the next - the BOOP rhythm. */
  step: 430,
  /** After the last system, before we go in. */
  ready: 1100,
} as const;

/**
 * The six areas, in the order they come online.
 *
 * ORDER IS THE MESSAGE. Up the left side and down the right, one at a time,
 * because the owner should be able to watch this and know what Genesis is
 * doing - storefront, then commerce, then the business itself, then the world,
 * then the people in it, then the settings around it. Activating a side at a
 * time would be faster and would say nothing.
 *
 * The coordinates are fractions of the artwork, measured against it and checked
 * by drawing them back over the image.
 */
const SYSTEMS = [
  { key: "storefront", label: "Storefront", cx: 0.110, cy: 0.383 },
  { key: "commerce", label: "Commerce", cx: 0.159, cy: 0.287 },
  { key: "business", label: "Business", cx: 0.246, cy: 0.220 },
  { key: "world", label: "World", cx: 0.772, cy: 0.218 },
  { key: "customers", label: "Customers", cx: 0.835, cy: 0.289 },
  { key: "settings", label: "Settings", cx: 0.884, cy: 0.382 },
] as const;

/** Where his eyes sit on this artwork's visor. Measured, then verified. */
const VISOR = { cx: 0.531, eyeY: 0.342, eyeDx: 0.058 };

export type BootPhase = "flipping" | "settling" | "waking" | "systems" | "ready";

export function J4Boot({
  userName,
  onDone,
}: {
  userName?: string | null;
  onDone: () => void;
}) {
  const [phase, setPhase] = useState<BootPhase>("flipping");
  const [lit, setLit] = useState(0);

  // REDUCED MOTION STILL TELLS THE STORY. It does not skip to the end - the
  // owner still sees the six systems come online, just without the flip and
  // with the rhythm tightened. The information is the point; the spectacle is
  // not the only thing carrying it.
  // READ AFTER MOUNT, NOT DURING RENDER. matchMedia answers differently on
  // the server and the client, so consulting it while rendering makes the
  // first client paint disagree with the server's - a hydration mismatch that
  // shows up as a dev warning today and as a flicker in production.
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    setReduced(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
  }, []);

  // THE TIMELINE MUST NOT RESTART ON EVERY PARENT RENDER.
  //
  // onDone arrives as an inline arrow from the shell, so it is a new function
  // on every render of a component that re-renders constantly. With it in the
  // dependency list, each of those renders cleared every timer and scheduled
  // them again from zero - and the sequence sat on the first frame forever,
  // flipping and never waking. The harness caught it by sampling state instead
  // of the clock: 25 seconds of polling and the count never left 0.
  //
  // Held in a ref so the latest callback is always used without the schedule
  // depending on its identity.
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  useEffect(() => {
    const T = BOOT_TIMELINE;
    const flip = reduced ? 0 : T.flip;
    const settle = reduced ? 120 : T.settle;
    const wake = reduced ? 200 : T.wake;
    const step = reduced ? 180 : T.step;

    const timers: ReturnType<typeof setTimeout>[] = [];
    const at = (ms: number, fn: () => void) => timers.push(setTimeout(fn, ms));

    at(flip, () => setPhase("settling"));
    at(flip + settle, () => setPhase("waking"));
    at(flip + settle + wake, () => setPhase("systems"));

    const base = flip + settle + wake;
    SYSTEMS.forEach((_, i) => at(base + step * (i + 1), () => setLit(i + 1)));

    const done = base + step * SYSTEMS.length;
    at(done + 200, () => setPhase("ready"));
    at(done + 200 + (reduced ? 500 : T.ready), () => onDoneRef.current());

    return () => timers.forEach(clearTimeout);
  }, [reduced]);

  const awake = phase === "waking" || phase === "systems" || phase === "ready";
  const name = userName?.trim() ? `, ${userName.trim().split(" ")[0]}` : "";

  return (
    <div
      data-testid="j4-boot"
      data-boot-phase={phase}
      className="fixed inset-0 z-[120] flex flex-col items-center justify-center gap-8 bg-black px-6"
      role="status"
      aria-live="polite"
      aria-label={`Genesis is starting. ${lit} of ${SYSTEMS.length} systems online.`}
    >
      <style>{`
        /* ONE ROTATION. It was two; Sean's call is that one clean flip is
           enough, because the six sequential activations carry the rest of
           the movement. The scale settles early so the last of the turn is
           purely rotation. */
        @keyframes j4boot-flip {
          0%   { transform: rotateY(0deg)   scale(.88) }
          70%  { transform: rotateY(250deg) scale(1) }
          100% { transform: rotateY(360deg) scale(1) }
        }
        @keyframes j4boot-eye  { from { opacity: 0; transform: scaleY(.2) } to { opacity: 1; transform: scaleY(1) } }
        @keyframes j4boot-boop { 0% { opacity: .9; transform: scale(.7) } 100% { opacity: 0; transform: scale(1.9) } }
        @keyframes j4boot-in   { from { opacity: 0 } to { opacity: 1 } }
        .j4boot-stage { animation: j4boot-flip ${BOOT_TIMELINE.flip}ms cubic-bezier(.22,.68,.24,1) both }
        .j4boot-eye   { animation: j4boot-eye ${BOOT_TIMELINE.wake}ms ease-out both; transform-origin: center }
        .j4boot-boop  { animation: j4boot-boop 620ms ease-out both }
        .j4boot-line  { animation: j4boot-in 700ms ease-out both }
        @media (prefers-reduced-motion: reduce) {
          .j4boot-stage, .j4boot-eye, .j4boot-boop, .j4boot-line { animation: none }
        }
      `}</style>

      <div className="relative" style={{ perspective: "1400px" }}>
        <div
          className={reduced ? undefined : "j4boot-stage"}
          style={{ transformStyle: "preserve-3d", willChange: "transform" }}
        >
          <div data-testid="j4-boot-stage" className="relative w-[min(74vw,26rem)]">
            <img
              src={ART_OFF}
              alt=""
              aria-hidden="true"
              className="block w-full select-none"
              draggable={false}
            />

            {/* THE SYSTEMS, OFF UNTIL THEY ARE NOT. Each patch covers the
                artwork's own lit icon; lifting it is the activation, so what
                switches on is the real icon rather than a drawing of one. */}
            {SYSTEMS.map((s, i) => {
              const on = i < lit;
              return (
                <div key={s.key} data-system={s.key} data-on={on ? "true" : "false"}>
                  {/* THE ACTIVATION IS A REVEAL. This paints the ON artwork
                      into a circle over the OFF one, aligned to this icon, and
                      fades it in. Nothing is filtered, traced or redrawn - the
                      icon that lights up is the artist's lit icon.

                      backgroundSize is the inverse of the patch's own width,
                      which is what makes the same fractional point land in both
                      layers. */}
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute rounded-full"
                    style={{
                      left: `${s.cx * 100}%`,
                      top: `${s.cy * 100}%`,
                      width: "13%",
                      height: "13%",
                      transform: "translate(-50%, -50%)",
                      backgroundImage: `url(${ART_ON})`,
                      backgroundSize: `${100 / 0.13}% auto`,
                      backgroundPosition: `${s.cx * 100}% ${s.cy * 100}%`,
                      opacity: on ? 1 : 0,
                      transition: `opacity ${BOOT_TIMELINE.power}ms ease-out`,
                    }}
                  />                  {on && (
                    <span
                      aria-hidden="true"
                      className="j4boot-boop pointer-events-none absolute rounded-full"
                      style={{
                        left: `${s.cx * 100}%`,
                        top: `${s.cy * 100}%`,
                        width: "13%",
                        height: "13%",
                        transform: "translate(-50%, -50%)",
                        border: "2px solid #7CFF5A",
                        boxShadow: "0 0 18px 4px rgba(124,255,90,.55)",
                      }}
                    />
                  )}
                </div>
              );
            })}

            {/* HIS EYES ARE AN ASSET, NOT A DRAWING (2026-09-04).

                This used to draw two rounded rectangles on the visor, and
                that is what produced the goofy face during the entrance.
                It is now Sean's own ON expression, registered onto this
                exact artwork and lifted out as a transparent layer.

                Same box, same object-contain, same position as the base -
                so waking up changes an opacity and moves nothing. */}
            <img
              src={ART_FACE}
              alt=""
              aria-hidden="true"
              draggable={false}
              className="pointer-events-none absolute inset-0 h-full w-full select-none object-contain transition-opacity"
              style={{
                opacity: awake ? 1 : 0,
                transitionDuration: `${BOOT_TIMELINE.wake}ms`,
              }}
            />
          </div>
        </div>
      </div>

      {/* THE WELCOME COMES FIRST, then what he is doing about it. */}
      <div className="j4boot-line max-w-sm text-center">
        <p className="text-[17px] font-medium text-white/90">
          Welcome back to Genesis{name}.
        </p>
        <p className="mt-1 text-[15px] text-white/55">
          {phase === "ready"
            ? "Everything's ready."
            : lit > 0
              ? `Bringing ${SYSTEMS[Math.min(lit, SYSTEMS.length) - 1].label} online…`
              : "Let me get everything set up for you."}
        </p>
      </div>
    </div>
  );
}
