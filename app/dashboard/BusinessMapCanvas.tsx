"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { BusinessMap, Certainty, MapDomainKey } from "@/lib/businessModel/businessMap";
import { entitiesFor, type MapProspect } from "@/lib/businessModel/mapEntities";
import { GENESIS_AVATAR_SIZE } from "@/lib/dashboard/genesisAvatarSize";
import { GenesisAvatar } from "./GenesisAvatar";
import { J4Icon, type J4IconName } from "./J4Icon";
import { MapCentreJ4 } from "./MapCentreJ4";
import { useJ4State } from "@/components/j4/useJ4State";
import { MapDataStream } from "./MapDataStream";
import { ConnectionChooser } from "./ConnectionChooser";
import { EntityCarousel } from "./EntityCarousel";
import { focusPlan } from "@/lib/businessModel/focusPlan";
import {
  getJ4FocusServerSnapshot,
  getJ4FocusSnapshot,
  subscribeJ4Focus,
} from "@/lib/dashboard/j4Focus";

// GOING INSIDE THE BUSINESS — NOW IN ONE STEP.
//
// ============ THE ORB IS J4 (2026-09-02) ==============================
//
// Sean: "The center of the Business Map should not say 'J4' as text. The
// center is the J4 orb. The orb IS J4... Treat the orb as a core part of the
// Business Map identity, not an icon that can be swapped for the text 'J4'."
//
// So the centre is the real GenesisAvatar — the same frozen canonical presence
// the arrival overlay, the composer and the tab bar all render, not a drawing
// of one — and it lives OUTSIDE the zooming <g>. That is the structural
// expression of "constant visual anchor": it is one element that is never
// unmounted and never rescaled by the world's transform, so when the map
// changes around it, it genuinely stays put rather than being redrawn in a new
// place each level.
//
// The edges stop at the orb's rim instead of running under it, so the picture
// is the one he described: business knowledge flowing into J4.
//
// ============ ONE STEP, NOT THREE ====================================
//
// Sean: "I don't think we need the intermediate category level anymore...
// entering that branch should transition directly into a carousel of the
// actual entities."
//
// There are now exactly two layers, and they answer different questions:
//
//   Layer 1 — SPATIAL     what parts does this business have, and which of
//                         them does J4 know anything about?
//   Layer 2 — ENTITY      what does J4 actually know about this one thing?
//
// The domain ring stays behind layer 2, zoomed in on the branch that was
// opened and faded to ambient, with its labels dropped. That is what keeps it
// one world: you flew into a branch, you did not switch screens. The browser
// suite still reads the world's real scale factor for that reason.

/**
 * HOW MUCH TEXT A BRANCH CAN CARRY BEFORE IT IS CUT.
 *
 * These were two magic numbers inline in the JSX, and the hit rectangle beside
 * them sized itself from the full untruncated string — so what was drawn and
 * what was targetable disagreed by however much had been trimmed. Named here,
 * applied once per branch, read by both.
 *
 * A branch label reaching this limit is a design problem rather than a display
 * one: "Traffic (your own site)" drew as "Traffic (your…", which says nothing.
 * verify-business-map-browser asserts no branch is drawn truncated, so a label
 * that does not fit fails a check instead of quietly becoming an ellipsis.
 */
const MAX_LABEL_CHARS = 15;
const MAX_SUB_CHARS = 18;

/**
 * The three states, in the order the map's own charter states them.
 *
 * One list, so the key cannot describe a state the picture does not draw, or
 * miss one it does. `Certainty` is the same union businessMap.ts emits, so
 * adding a fourth state there fails to compile here rather than quietly going
 * unexplained on screen.
 */
/**
 * WHAT EACH PART OF THE BUSINESS LOOKS LIKE (2026-09-17, Sean).
 *
 * "Small recognizable icons representing what each branch means... immediately
 * communicating their purpose." A branch was a coloured dot and a word; the
 * dot carried provenance and nothing carried meaning, so every branch looked
 * like every other branch until you read it.
 *
 * `Record<MapDomainKey, …>` deliberately: adding a domain to MAP_DOMAINS and
 * not giving it a face fails to COMPILE rather than drawing a nameless circle
 * on the owner's business. That is the same guard DOMAIN_LABEL has, and the
 * lesson DOMAIN_ORDER taught this file the hard way.
 *
 * Four of these glyphs did not exist and were added to the icon system rather
 * than approximated from something close — see J4Icon.tsx.
 */
const DOMAIN_ICON: Record<MapDomainKey, J4IconName> = {
  business: "business",
  commerce: "orders",
  customers: "customers",
  financials: "payments",
  goals: "goal",
  traffic: "analytics",
  social: "share",
  connections: "connections",
  creation: "idea",
  learned: "learning",
};

const MAP_KEY: ReadonlyArray<{ state: Certainty; label: string }> = [
  { state: "known", label: "from your data" },
  { state: "inferred", label: "J4 worked it out" },
  { state: "unknown", label: "not known yet" },
];

/**
 * WHAT A STREAM IS CARRYING, AND ONLY WHAT IT REALLY CARRIES (2026-09-18).
 *
 * Sean: "Layer small, glowing contextual indicators directly onto/along those
 * paths... These are not new data claims and must not be invented. They are
 * visual representations of data J4 actually has."
 *
 * So there are exactly two sources, both already on screen elsewhere:
 *
 *   A CONNECTED PROVIDER, drawn as its own favicon — the same
 *   `https://<iconDomain>/favicon.ico` the connection chooser already shows,
 *   and only for a service this store has genuinely connected. That is what
 *   puts X, Instagram or YouTube on the Social stream when, and only when,
 *   those accounts are connected.
 *
 *   OTHERWISE A REAL ROW, drawn as the domain's own glyph — one per thing J4
 *   actually holds in that domain, never more.
 *
 * The cap is three because a stream is a stream, not an inventory; the count
 * beside the branch is what states the total. An indicator can therefore never
 * out-number the data, which is the assertion this exists to be held to.
 */
const MAX_INDICATORS = 3;

interface StreamIndicator {
  /** A provider's own favicon, or null to draw the domain's glyph instead. */
  src: string | null;
  /** What it stands for, for the assertion and for nothing visual. */
  of: string;
}

function indicatorsFor(
  key: MapDomainKey,
  services: MapService[],
  nodeCount: number,
): StreamIndicator[] {
  const connected = services.filter(
    (s) => s.domain === key && s.connected && s.iconDomain,
  );
  if (connected.length > 0) {
    return connected.slice(0, MAX_INDICATORS).map((s) => ({
      src: `https://${s.iconDomain}/favicon.ico`,
      of: s.name,
    }));
  }
  return Array.from({ length: Math.min(MAX_INDICATORS, nodeCount) }, () => ({
    src: null,
    of: key,
  }));
}

function ellipsise(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

interface Geometry {
  w: number; h: number; cx: number; cy: number;
  /** Radius of the ring of domains around the orb. */
  ring: number; ringSquash: number;
  /** Where an edge starts — the orb's rim, in viewBox units. */
  hub: number;
  dot: number;
  /** The branch ring — large enough to hold its icon. */
  node: number;
  /** The glyph inside that ring. */
  icon: number;
  /** A travelling parcel of information. */
  packet: number;
  /** A contextual indicator riding the stream. */
  badge: number;
  label: number; sub: number; gap: number;
  hit: number;
}

const WIDE: Geometry = {
  w: 900, h: 476, cx: 450, cy: 238,
  ring: 262, ringSquash: 0.74,
  hub: 78, dot: 9, node: 17, icon: 18, packet: 3.2, badge: 9,
  label: 16, sub: 12.5, gap: 22, hit: 30,
};

// Not a shrunken copy: a tighter ring with LARGER type, its radius set by the
// longest label so "Connections" cannot clip to "onnections".
const NARROW: Geometry = {
  w: 460, h: 384, cx: 230, cy: 192,
  ring: 120, ringSquash: 0.98,
  hub: 54, dot: 7, node: 13, icon: 14, packet: 2.6, badge: 7.5,
  label: 15, sub: 11.5, gap: 16, hit: 22,
};

export interface MapService {
  id: string;
  name: string;
  domain: MapDomainKey;
  available: boolean;
  connected: boolean;
  description: string;
  signupUrl: string | null;
  manage: DomainDestination | null;
  /** The provider's own domain, for its own favicon. Null when unverified. */
  iconDomain: string | null;
}

export interface DomainDestination {
  label: string;
  href: string;
}

function certaintyColor(c: Certainty): string {
  if (c === "known") return "var(--map-known)";
  if (c === "inferred") return "var(--map-inferred)";
  return "var(--map-unknown)";
}

/** One domain placed on the ring. */
interface Placed {
  key: MapDomainKey;
  label: string;
  sub: string;
  certainty: Certainty;
  x: number;
  y: number;
}

export function BusinessMapCanvas({
  map,
  services,
  prospects,
  destinations,
  noticed,
}: {
  map: BusinessMap;
  services: MapService[];
  prospects: Partial<Record<MapDomainKey, MapProspect[]>>;
  destinations: Partial<Record<MapDomainKey, DomainDestination>>;
  /** Real GenesisObservations, keyed by the record they are about. */
  noticed: Record<string, string[]>;
}) {
  /** The domain being looked inside, or null for the whole business. */
  const [open, setOpen] = useState<MapDomainKey | null>(null);
  const [chooserOpen, setChooserOpen] = useState(false);
  const [narrow, setNarrow] = useState(false);
  // ONE J4, THE SAME ONE. The centre reads the store the dock and the Office
  // band read, so the J4 an owner just left in the corner is recognisably the
  // one now at the middle of their business — not a second drawing of him
  // having a different day.
  const { state: centreState } = useJ4State();
  const [reducedMotion, setReducedMotion] = useState(true);


  useEffect(() => {
    const narrowQ = window.matchMedia("(max-width: 640px)");
    const motionQ = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => {
      setNarrow(narrowQ.matches);
      setReducedMotion(motionQ.matches);
    };
    apply();
    narrowQ.addEventListener("change", apply);
    motionQ.addEventListener("change", apply);
    return () => {
      narrowQ.removeEventListener("change", apply);
      motionQ.removeEventListener("change", apply);
    };
  }, []);

  const G = narrow ? NARROW : WIDE;

  const domain = open ? map.domains.find((d) => d.key === open) ?? null : null;
  const entities = useMemo(
    () => (domain ? entitiesFor(domain, prospects[domain.key] ?? []) : []),
    [domain, prospects],
  );

  /**
   * THE PICTURE IS THE DATA (2026-09-17).
   *
   * This used to place a hand-written DOMAIN_ORDER list. Traffic was added to
   * MAP_DOMAINS and never to that list, so the sentence above the map counted
   * ten branches while the map drew nine — and the one it silently dropped was
   * the branch that had just been built. Nothing was broken enough to fail:
   * the count was right, the map was pretty, and Traffic simply was not there.
   *
   * The same shape has now cost this repository four separate defects: a list
   * kept by hand next to the thing it describes IS the drift it was meant to
   * prevent. So the ring is placed straight off the domains the server sent.
   * A branch that exists in the model is drawn, and one that does not, is not.
   * There is no second list to forget.
   */
  // HOW MANY BRANCHES ARE IN EACH STATE, counted off the same domains the ring
  // is placed from — so the key and the picture cannot disagree about what is
  // on screen.
  const stateCounts = useMemo(() => {
    const counts: Record<Certainty, number> = { known: 0, inferred: 0, unknown: 0 };
    for (const d of map.domains) counts[d.certainty] += 1;
    return counts;
  }, [map]);

  const ring = useMemo<Placed[]>(() => {
    const domains = map.domains;
    return domains.map((d, i) => {
      const key = d.key;
      const angle = (i / domains.length) * Math.PI * 2 - Math.PI / 2;
      // WHAT IS REALLY IN THERE, INCLUDING WHAT COULD BE. Social has no nodes
      // and four platforms behind it; counting only nodes made the branch read
      // "not known yet" and then open onto four cards. The count and the
      // contents are now the same list.
      const count = d.nodes.length + (prospects[key]?.length ?? 0);
      return {
        key,
        label: d.label,
        sub: count > 0 ? `${count}` : "not known yet",
        certainty: d.certainty,
        x: G.cx + Math.cos(angle) * G.ring,
        y: G.cy + Math.sin(angle) * G.ring * G.ringSquash,
      };
    });
  }, [map, prospects, G]);

  // ---- depth is a real scale change, not a nudge --------------------------
  //
  // Entering a branch flies the world INTO that branch: the camera centres on
  // the node that was opened and the scale genuinely grows. The ring then sits
  // behind the carousel as ambient structure.
  const focused = open ? ring.find((r) => r.key === open) ?? null : null;
  const worldScale = open ? 2.2 : 1;
  const camX = focused ? focused.x : G.cx;
  const camY = focused ? focused.y : G.cy;

  // WHAT J4 HAS ASKED TO BE BROUGHT FORWARD (2026-09-03).
  //
  // Focus arrives as node ids the server already resolved against this
  // store's own map, and `focusPlan` turns them into the two things this
  // canvas can act on: which domain to open, and which entities to mark.
  //
  // NO SECOND REGISTRY. The plan is computed from the same `map` prop this
  // component already renders, so there is nothing here that could disagree
  // with what is on screen.
  const j4Focus = useSyncExternalStore(
    subscribeJ4Focus,
    getJ4FocusSnapshot,
    getJ4FocusServerSnapshot,
  );
  const plan = useMemo(() => focusPlan(map, j4Focus.nodeIds), [map, j4Focus.nodeIds]);

  const step = useCallback((key: MapDomainKey) => {
    setOpen(key);
    // CONNECTIONS KEEPS THE CHOOSER. Sean: "Connections should keep the
    // chooser we just built — that's the right pattern for that branch."
    setChooserOpen(key === "connections");
  }, []);

  // NAVIGATION IS AN EVENT; MARKING IS RENDER STATE. J4 asking for focus is
  // something that HAPPENS, so opening the domain belongs in the
  // subscription callback rather than in an effect that fires on render -
  // which is also what stops it fighting the owner. Once J4 has opened a
  // domain, an owner who taps somewhere else stays where they tapped,
  // because nothing re-applies the focus on the next render.
  //
  // Opening goes through `step`, the same function a click uses, so J4 and a
  // tap cannot drift apart - including the Connections chooser step() sets.
  useEffect(
    () =>
      subscribeJ4Focus(() => {
        const next = focusPlan(map, getJ4FocusSnapshot().nodeIds);
        if (next.domain) step(next.domain);
      }),
    [map, step],
  );

  const reset = useCallback(() => {
    setChooserOpen(false);
    setOpen(null);
  }, []);

  const destination = open ? destinations[open] ?? null : null;

  return (
    <section
      data-screen="business-map"
      aria-label="What J4 understands about your business"
      className="business-map"
    >
      <style>{`
        /* ============ THE MAP IS AN ENVIRONMENT, NOT A SHEET ==========
           Sean, with a reference composition (2026-09-18): "The background
           should feel immersive, and the branches/streams/icons should sit on
           top of the environment, almost like a holographic HUD... not like a
           normal dashboard card with lines drawn on top."

           So the stage carries its own dark ground at every page theme rather
           than following it. The map has always been the single bounded object
           on a boxless room; it is now a bounded WINDOW INTO something rather
           than a panel with a diagram printed on it.

           THE THREE PROVENANCE COLOURS ARE THE ONES THAT ALREADY EXISTED.
           These are verbatim the values this file already shipped for dark
           mode - nothing new is invented, and the three states keep their hues
           and their meanings. They simply apply always now, because the ground
           is always dark. Keeping the light values would have put a #1f6b4c
           dot on near-black and cost the very distinction the map exists to
           make. */
        .business-map {
          --map-known: #5fb98f;
          --map-inferred: #7fadf5;
          --map-unknown: #78838a;
          --map-ink: #e6ebed;
          --map-soft: #a5b0b6;
          --map-surface: #0b1013;
          --map-ground: #070b0e;
          --map-stream: #7fadf5;
        }

        /* ============ INFORMATION ARRIVING (2026-09-18) ===============
           This was one dash travelling per line, drawn with stroke-dashoffset.
           It was honest and it read as a dotted line sliding, because that is
           what it was: every dash on a stroke moves in lockstep at even
           spacing. Sean: "They should look like data packets flowing from each
           domain into J4."

           So the marks are now separate elements on the same path, each
           starting at its own moment. offset-path hands the motion to the
           browser: nothing is timed in a render, nothing drifts out of step
           with React, and reduced motion can stop it in one rule.

           The stream runs branch -> centre, so 0%..100% IS the direction the
           information travels. Fading in and out at the ends keeps a packet
           from popping into existence on top of the node it left. */
        @keyframes map-packet {
          0%   { offset-distance: 0%;   opacity: 0; }
          12%  { opacity: 1; }
          82%  { opacity: 1; }
          100% { offset-distance: 100%; opacity: 0; }
        }
        .business-map .map-packet {
          offset-rotate: 0deg;
          animation: map-packet 2.7s linear infinite;
        }
        /* The streams glow because this is an environment, not a diagram. Kept
           on the stream and its packets only, so labels and counts stay crisp
           type rather than neon. */
        .business-map .map-stream-line,
        .business-map .map-packet {
          filter: drop-shadow(0 0 3px currentColor);
        }
        .business-map .map-stream-line { color: var(--map-known); }

        /* MOTION IS THE ONLY THING REMOVED. The packets stop where they are
           rather than disappearing, so a still map still shows each stream
           carrying something. Nothing is hidden to satisfy the preference. */
        @media (prefers-reduced-motion: reduce) {
          .business-map .map-packet { animation: none; offset-distance: 62%; }
        }

        /* ============ THE INTELLIGENCE AT THE CENTRE ==================
           A neural field behind J4 rather than a flat disc: the streams arrive
           into something that looks like it is thinking. Drawn in the map's
           own tokens, so it follows the same palette as everything else and
           introduces no new colour. */
        @keyframes map-synapse {
          0%, 100% { opacity: .35; transform: scale(1); }
          50%      { opacity: .6;  transform: scale(1.04); }
        }
        .business-map .map-neural { animation: map-synapse 5.5s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) {
          .business-map .map-neural { animation: none; }
        }
        /* The dark-mode override that used to sit here held exactly these
           values and is gone: one declaration now, so the two cannot drift. */
        .business-map .map-stage { touch-action: pan-y; }
        .business-map .hit { cursor: pointer; }
        .business-map .hit:focus-visible { outline: 2px solid var(--map-inferred); outline-offset: 3px; }
        .business-map .map-world { transition: transform 460ms cubic-bezier(.22,.7,.24,1), opacity 320ms ease; }
        .business-map .map-orb { transition: top 420ms cubic-bezier(.22,.7,.24,1), width 420ms cubic-bezier(.22,.7,.24,1); }
        .business-map .lvl { transition: opacity 300ms ease; }
        /* THE ENTITIES ARRIVE AFTER THE ORB HAS MOVED (2026-09-02).
           Caught by a bounding-box assertion, not by eye: for the ~420ms the
           orb takes to glide from the centre to the top, it travels straight
           across cards that were already fully drawn. Fading them in behind it
           makes the orb's move the thing you watch, which is the point --
           J4 stays, the context around it changes. */
        .business-map .map-entities { animation: mapEntitiesIn 300ms ease 140ms both; }
        @keyframes mapEntitiesIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
        @media (prefers-reduced-motion: reduce) {
          .business-map .map-world, .business-map .lvl, .business-map .map-orb { transition: none; }
          .business-map .map-entities { animation: none; }
        }
      `}</style>

      <div className="overflow-hidden rounded-2xl border border-black/[.07] bg-[var(--map-ground)] dark:border-white/[.10]">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-black/[.06] px-4 py-2.5 dark:border-white/[.08]">
          <p className="flex min-w-0 flex-wrap items-center gap-1 text-xs text-[var(--map-soft)]">
            <button type="button" onClick={reset}
              className={open === null ? "font-medium text-[var(--map-inferred)]" : "underline underline-offset-2"}
            >Whole business</button>
            {domain && (
              <span className="flex items-center gap-1">
                <span aria-hidden>›</span>
                <span className="truncate font-medium text-[var(--map-ink)]">{domain.label}</span>
              </span>
            )}
            {open === null && <span className="ml-1">— tap a branch to go inside</span>}
          </p>
          <div className="flex shrink-0 items-center gap-1">
            <button type="button" onClick={reset} disabled={open === null} data-testid="map-back"
              className="rounded-full border border-black/[.08] px-2.5 py-1 text-[11px] text-[var(--map-soft)] disabled:opacity-40 dark:border-white/[.145]"
            >Back</button>
          </div>
        </div>

        <div
          className={`map-stage relative w-full select-none overflow-hidden bg-[var(--map-surface)] ${
            open
              // THE CAROUSEL IS THE RICHER LAYER, so it is given real height
              // on a phone, where the page simply scrolls. On a desktop it
              // keeps the SAME height as the whole-business view: a taller
              // stage pushed the panel past the dashboard's own viewport
              // region and clipped the card's actions off the bottom (seen in
              // a screenshot). The room a desktop card needs is width, which
              // it gets by laying out landscape below.
              ? "h-[560px] sm:h-[400px] lg:h-[470px]"
              : "h-[330px] sm:h-[400px] lg:h-[470px]"
          }`}
        >
          <MapDataStream reducedMotion={reducedMotion} />

          <svg
            viewBox={`0 0 ${G.w} ${G.h}`}
            className="absolute inset-0 h-full w-full"
            role="img"
            aria-label={
              open
                ? `Inside ${domain?.label ?? ""}`
                : `J4 at the centre with ${ring.length} branches: ${ring.map((c) => c.label).join("; ")}`
            }
            aria-hidden={open ? true : undefined}
          >
            <defs>
              <radialGradient id="mapGlow">
                <stop offset="0%" stopColor="var(--map-inferred)" stopOpacity="0.30" />
                <stop offset="100%" stopColor="var(--map-inferred)" stopOpacity="0" />
              </radialGradient>
            </defs>

            <g
              className="map-world"
              data-testid="map-world"
              data-scale={worldScale.toFixed(2)}
              opacity={open ? 0.14 : 1}
              style={open ? { pointerEvents: "none" } : undefined}
              transform={`translate(${G.cx} ${G.cy}) scale(${worldScale}) translate(${-camX} ${-camY})`}
            >
              {!open && <circle cx={G.cx} cy={G.cy} r={G.hub * 1.7} fill="url(#mapGlow)" />}

              {/* EDGES STOP AT THE ORB'S RIM — knowledge flowing into J4,
                  rather than lines disappearing under a disc. */}
              {ring.map((c) => {
                const dx = c.x - G.cx;
                const dy = c.y - G.cy;
                const len = Math.hypot(dx, dy) || 1;
                const x1 = G.cx + (dx / len) * G.hub;
                const y1 = G.cy + (dy / len) * G.hub;
                // Stop at the RING, not the centre of it, so the line meets
                // the icon's edge rather than running under the glyph.
                const x2 = c.x - (dx / len) * G.node;
                const y2 = c.y - (dy / len) * G.node;
                return (
                  <g key={`e-${c.key}`}>
                    <line
                      x1={x1} y1={y1} x2={x2} y2={y2}
                      stroke={certaintyColor(c.certainty)}
                      strokeWidth={c.certainty === "unknown" ? 1 : 1.6}
                      strokeDasharray={c.certainty === "unknown" ? "4 5" : undefined}
                      opacity={c.certainty === "unknown" ? 0.35 : 0.75}
                    />
                    {/* ============ THE CONNECTION IS ALIVE, AND ONLY WHERE
                        THERE IS SOMETHING TO CARRY (2026-09-17, Sean) ========

                        "The connection itself should visually communicate that
                        J4 is taking information from that part of the business
                        and organizing it."

                        So a second stroke runs along the same line, dashed and
                        travelling — and it travels TOWARDS the centre, because
                        that is the direction the sentence describes. J4 is
                        taking it in, not broadcasting it out.

                        THE MOVEMENT IS EVIDENCE, NOT DECORATION, and that is
                        the part worth defending. A branch J4 knows nothing
                        about carries nothing, so it gets no flow at all — its
                        line stays the static dashed one above. An owner can
                        read which parts of their business are actually feeding
                        J4 without reading a single number, and the animation
                        cannot say "data is moving" where there is none.
                        verify-business-map-browser asserts exactly that. */}
                    {c.certainty !== "unknown" && (() => {
                      const view = map.domains.find((d) => d.key === c.key);
                      const indicators = indicatorsFor(c.key, services, view?.nodes.length ?? 0);
                      // The stream runs BRANCH -> CENTRE, so offset-distance
                      // 0%..100% is the direction the information travels.
                      const path = `M ${x2} ${y2} L ${x1} ${y1}`;
                      return (
                        <>
                          {/* The channel itself: brighter than the line under
                              it, so a stream that carries something looks
                              different from one that does not before anything
                              moves at all. */}
                          <line
                            data-flow={c.key}
                            x1={x1} y1={y1} x2={x2} y2={y2}
                            stroke={certaintyColor(c.certainty)}
                            strokeWidth={2.4}
                            strokeLinecap="round"
                            opacity={0.35}
                            className="map-stream-line"
                          />
                          {/* ============ PARCELS, NOT A DOTTED LINE =======
                              Sean: "the animated particles/dots should travel
                              along the existing connection paths toward J4,
                              rather than simply appearing as dotted lines.
                              They should look like data packets flowing from
                              each domain into J4."

                              A dash pattern could not do this. Every dash on a
                              stroke moves in lockstep and is evenly spaced, so
                              it reads as one dotted line sliding — which is
                              exactly what it was. These are separate marks on
                              the same path, each starting at its own moment,
                              so they read as things arriving one after
                              another.

                              offset-path rather than JavaScript: the browser
                              owns the motion, nothing is timed in a render,
                              and prefers-reduced-motion can stop it in CSS. */}
                          {[0, 1, 2].map((i) => (
                            <circle
                              key={i}
                              data-packet={c.key}
                              className="map-packet"
                              r={G.packet}
                              fill={certaintyColor(c.certainty)}
                              style={{ offsetPath: `path("${path}")`, animationDelay: `${i * 0.9}s` }}
                            />
                          ))}
                          {/* WHAT THE STREAM IS CARRYING, riding it at fixed
                              stations so the eye can read them while the
                              packets move past. Never more of these than there
                              is data — see indicatorsFor. */}
                          {indicators.map((ind, i) => {
                            const t = 0.34 + i * 0.17;
                            const bx = x2 + (x1 - x2) * t;
                            const by = y2 + (y1 - y2) * t;
                            return (
                              <g key={`${c.key}-ind-${i}`} data-stream-indicator={c.key} aria-hidden="true">
                                <circle
                                  cx={bx} cy={by} r={G.badge}
                                  fill="var(--map-surface)"
                                  stroke={certaintyColor(c.certainty)}
                                  strokeWidth={1}
                                  opacity={0.95}
                                />
                                {ind.src ? (
                                  <image
                                    href={ind.src}
                                    x={bx - G.badge * 0.62} y={by - G.badge * 0.62}
                                    width={G.badge * 1.24} height={G.badge * 1.24}
                                  />
                                ) : (
                                  <g
                                    transform={`translate(${bx - G.badge * 0.62}, ${by - G.badge * 0.62})`}
                                    style={{ color: certaintyColor(c.certainty) }}
                                  >
                                    <J4Icon name={DOMAIN_ICON[c.key]} size={G.badge * 1.24} />
                                  </g>
                                )}
                              </g>
                            );
                          })}
                        </>
                      );
                    })()}
                  </g>
                );
              })}

              {ring.map((c) => {
                const right = c.x > G.cx + 1;
                const centred = Math.abs(c.x - G.cx) <= 1;
                const anchor = centred ? "middle" : right ? "start" : "end";
                const dx = centred ? 0 : right ? G.gap : -G.gap;
                const dy = centred ? (c.y > G.cy ? G.label * 1.9 : -G.label * 1.4) : 0;
                // ============ ONE STRING, DRAWN AND TARGETED ============
                //
                // The text below used to truncate inline while the hit
                // rectangle above sized itself from the UNTRUNCATED label, so
                // the tap area and the visible words were two answers to the
                // same question. "Traffic (your own site)" drew as "Traffic
                // (your…" — 14 characters — and claimed a target wide enough
                // for 23. The label is trimmed once, here, and everything that
                // needs it reads the same variable.
                const shownLabel = ellipsise(c.label, MAX_LABEL_CHARS);
                const shownSub = ellipsise(c.sub, MAX_SUB_CHARS);
                return (
                  <g key={c.key} className={open ? undefined : "hit"}
                    role={open ? undefined : "button"}
                    tabIndex={open ? undefined : 0}
                    data-level="child"
                    /* THE BRANCH NAMES ITSELF, so a check can ask which
                       branches were drawn instead of reading the labels back
                       out of the picture. */
                    data-branch={c.key}
                    aria-label={open ? undefined : `${c.label}, ${c.sub}`}
                    onClick={open ? undefined : () => step(c.key)}
                    onKeyDown={(e) => {
                      if (open) return;
                      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); step(c.key); }
                    }}
                  >
                    {/* ============ THE WHOLE BRANCH IS THE TARGET ==========
                        This was a transparent circle around the DOT, and the
                        label beside it was only tappable where a glyph happened
                        to be — the space between the dot and its own text hit
                        nothing at all. On a phone that gap is most of what a
                        thumb aims at, and it is the same defect the order rows
                        had: the thing that looks pressable is a block, and only
                        a few pixels inside it were.
                        The dot, the label and the count are now one target. */}
                    {!open && (() => {
                      const chars = Math.max(shownLabel.length, shownSub.length);
                      const est = chars * G.label * 0.56;
                      const x0 = centred ? c.x - Math.max(G.hit, est / 2)
                        : right ? c.x - G.hit : c.x + dx - est;
                      const x1 = centred ? c.x + Math.max(G.hit, est / 2)
                        : right ? c.x + dx + est : c.x + G.hit;
                      const y0 = Math.min(c.y - G.hit, c.y + dy - G.label * 1.25);
                      const y1 = Math.max(c.y + G.hit, c.y + dy + G.sub * 1.7);
                      return (
                        <rect data-branch-hit={c.key}
                          x={x0} y={y0} width={x1 - x0} height={y1 - y0}
                          fill="transparent" />
                      );
                    })()}
                    {/* ============ THE NODE IS A FACE NOW (2026-09-17) =====
                        Sean: "meaningful icon → domain → real data... They
                        should feel alive, interactive and fun while still
                        immediately communicating their purpose."

                        THE PROVENANCE CIRCLE IS UNTOUCHED, and that is the
                        point. This <circle> still carries the fill and the
                        1.6px stroke that say which of the three states the
                        branch is in, and the key still reproduces it exactly —
                        the ring simply grew enough to hold something inside
                        it. An icon that replaced the circle would have traded
                        the map's central meaning for decoration.

                        NOT A CARD. The branch stays a mark on the stage with
                        its name beside it: no border, no panel, no radius. The
                        reference composition puts every domain in a rounded
                        box, and the room this map lives in is boxless by an
                        approved decision. */}
                    <circle
                      /* NAMED, because the branch now contains other circles.
                         Three icons are drawn with them — customers, share and
                         goal — so "[data-branch] circle" started counting
                         glyph internals as provenance dots and the key's
                         counts stopped matching the picture. The dot says
                         which dot it is. */
                      data-branch-dot={c.key}
                      cx={c.x} cy={c.y} r={G.node}
                      fill={c.certainty === "unknown" ? "var(--map-surface)" : certaintyColor(c.certainty)}
                      stroke={certaintyColor(c.certainty)} strokeWidth={1.6} />
                    {/* The glyph sits ON the state colour, so it reads against
                        a filled ring and a hollow one alike. */}
                    <g
                      data-branch-icon={c.key}
                      transform={`translate(${c.x - G.icon / 2}, ${c.y - G.icon / 2})`}
                      style={{ color: c.certainty === "unknown" ? "var(--map-unknown)" : "var(--map-surface)" }}
                    >
                      <J4Icon name={DOMAIN_ICON[c.key]} size={G.icon} />
                    </g>
                    {/* LABELS ONLY WHERE THEY CAN BE READ. Behind the carousel
                        the ring is structure, not text — 2.2x type sliding
                        under a card is noise, and half of it would be off the
                        stage anyway. */}
                    {!open && (
                      <>
                        <text x={c.x + dx} y={c.y + dy - 1} textAnchor={anchor}
                          fill="var(--map-ink)" fontSize={G.label} fontWeight={600}>
                          {shownLabel}
                        </text>
                        <text x={c.x + dx} y={c.y + dy + G.label * 1.05} textAnchor={anchor}
                          fill="var(--map-soft)" fontSize={G.sub}>
                          {shownSub}
                        </text>
                      </>
                    )}
                  </g>
                );
              })}
            </g>
          </svg>

          {/* ============ THE CONSTANT ANCHOR ==============================
              ONE element, rendered in both layers, never remounted — which is
              what lets it hold its column while everything else changes. It is
              deliberately outside the <svg> and outside every conditional. */}
          <div
            data-testid="map-centre"
            className={`map-orb pointer-events-none absolute left-1/2 z-10 flex -translate-x-1/2 flex-col items-center ${
              open ? "top-3" : "top-1/2 -translate-y-1/2"
            }`}
          >
            {/* THE CENTRE IS THE BUSINESS, NOT J4 (2026-09-04, Sean).

                The Business Map milestone made this orb J4 himself, and that
                was right while J4 had no home of his own. He has one now - the
                corner - and Sean's rule is one J4 identity in the application.
                A second J4 floating in the middle of the map is exactly the
                competing representation that rule exists to stop.

                So the hub goes back to meaning what the map says it means:
                the whole business, with the branches coming off it. The
                element itself is untouched - same node, same testid, never
                remounted - because verify-business-map-browser tracks its
                identity through the open/close transition and a redrawn
                centre would fail that on purpose. */}
            {/* ============ AND BACK TO J4, DELIBERATELY (2026-09-17) ======
                The paragraph above is the 2026-09-04 decision and it has been
                reversed by the person who made it. Sean, with a reference
                composition: "I want the J4 head to be the intelligence at the
                center, not a generic glowing ball... Use the canonical J4
                artwork and the correct J4 emblem."

                What sat here was neither J4 nor the business: a radial
                gradient in a span. The 2026-09-04 concern was a COMPETING J4
                identity — a second, different drawing of him floating in the
                middle of the map. That is not what this is. It is the same
                J4Character the dock and the Office band render, reading the
                same `useJ4State` they read, so there is one J4 in the
                application who happens to be at the centre of his own map
                rather than two pictures disagreeing about who he is.

                THE ELEMENT AROUND HIM IS UNTOUCHED — same node, same testid,
                never remounted — because the suite tracks the centre's
                identity through the open/close transition and a redrawn
                centre fails that on purpose.

                The box keeps its former size at both states, so the edges
                still stop exactly at the rim they always stopped at. */}
            {/* HE SITS IN THE MAP RATHER THAN ON IT.
                The artwork is a square frame with a dark ground baked into it,
                which is right in his own corner and read as a photograph
                pasted onto this one — the map's surface is light. The artwork
                is NOT altered: it is presented through a round aperture with a
                soft field behind it, which is how the reference composition
                holds him too. The glow is the map's own ink, not a new colour. */}
            {/* ============ THE NEURAL FIELD HE SITS IN (2026-09-18) ====
                Sean's reference is a head with a lit brain, and the streams
                arriving into it. We do not have rear-view artwork and none is
                invented here: this is a field drawn around the canonical
                J4Character, in the map's own tokens, so the centre reads as
                something thinking rather than a portrait on a disc.

                Behind him, so it never covers his face, and pointer-events
                stay off it entirely. */}
            <span
              aria-hidden="true"
              className="map-neural pointer-events-none absolute left-1/2 top-1/2 -z-10 block -translate-x-1/2 -translate-y-1/2 rounded-full"
              style={{
                width: open ? "5rem" : narrow ? "13rem" : "16rem",
                height: open ? "5rem" : narrow ? "13rem" : "16rem",
                background:
                  "radial-gradient(circle at 50% 50%, color-mix(in oklab, var(--map-known) 30%, transparent) 0%, color-mix(in oklab, var(--map-known) 12%, transparent) 38%, transparent 68%)",
              }}
            />
            {/* ============ THE REAR VIEW, MAP ONLY (2026-09-18) =======
                Sean supplied the render and the instruction: "Use that
                rear-view J4 as the center visual for Business Map only. Do not
                replace the shared J4Character artwork, because the front-view
                J4 is still required everywhere else."

                So this is MapCentreJ4, which owns the map's asset and nothing
                else does. J4Character keeps its single render and the dock, the
                Office and the composer are untouched — see MapCentreJ4.tsx for
                why this could not be a prop on that component without
                weakening a real invariant.

                THE ROUND APERTURE IS GONE, and that is the asset's doing
                rather than a redesign: the render is a portrait of a head,
                shoulders and the emblem on his back, and a circle cut through
                the middle of it. The feathering moved onto the render itself,
                so he still ends in the environment rather than on a seam.

                Everything around him is frozen: the streams, the parcels, the
                indicators, the counts, the provenance and every branch target
                are exactly as they were in 0e91bc6. */}
            <MapCentreJ4
              state={centreState}
              /* Sized so he is the intelligence at the centre rather than a
                 token in it, and stopped short of the innermost stream
                 indicator so nothing he sits over is something the map is
                 trying to say. Streams pass BEHIND him, which is the
                 reference's own arrangement. */
              width={open ? 34 : narrow ? 104 : 132}
              title={`J4 — ${centreState}`}
            />
            {/* The branch reads as flowing OUT of J4, which is the direction
                Sean drew: orb, then down, then the things. */}
            {open && domain && (
              <>
                <span aria-hidden className="mt-1 h-3 w-px bg-[var(--map-soft)] opacity-40" />
                <p className="mt-1 text-[13px] font-semibold text-[var(--map-ink)]">{domain.label}</p>
                <p className="text-[11px] text-[var(--map-soft)]">
                  {entities.length > 0
                    ? `${entities.length} ${entities.length === 1 ? "thing" : "things"} J4 has gathered`
                    : "nothing gathered yet"}
                </p>
              </>
            )}
          </div>

          {/* ============ LAYER 2 — WHAT J4 KNOWS ABOUT EACH THING ========= */}
          {open && open !== "connections" && (
            <div className="map-entities absolute inset-x-0 bottom-0 top-[132px] flex flex-col sm:top-[152px]">
              <EntityCarousel
                focusedIds={plan.nodeIds}
                entities={entities}
                domainLabel={domain?.label ?? ""}
                destination={destination}
                noticed={noticed}
                onConnect={() => setChooserOpen(true)}
              />
            </div>
          )}

          {chooserOpen && (
            <ConnectionChooser
              services={services}
              connectionsHref={destinations.connections?.href ?? "#"}
              onClose={() => {
                setChooserOpen(false);
                if (open === "connections") setOpen(null);
              }}
            />
          )}
        </div>

        {/* ============ WHERE J4'S KNOWLEDGE CAME FROM (2026-09-17) =======
            businessMap.ts calls the three states "one of the core reasons
            we're building the map... don't flatten those states for visual
            simplicity". On a phone they were three 8px dots and 11px of grey
            text in the corner of a footer, sharing a line with a sentence —
            the map's central idea, presented as a caption.

            Three things changed, and none of them is a badge:

            1. THE SWATCH IS THE DOT. It was a filled circle for all three
               states; on the map, "not known yet" is a HOLLOW ring — surface
               fill, coloured stroke. The key drew a solid grey dot for a state
               the picture draws as an outline, so the one state hardest to
               read was the one the key described wrongly. Each swatch now
               carries the same fill and the same 1.6px stroke as the circle it
               stands for.

            2. IT COUNTS. How many branches are in each state is the honest
               version of the reference's "Data Health 92%" — the same question
               asked where there is a real denominator. Nothing is estimated,
               nothing is scored, and a zero is shown as a zero.

            3. IT IS BIG ENOUGH TO READ, and the sentence has its own line
               instead of competing for this one.

            Still not a claim of certainty: "J4 worked it out" stays a separate
            colour from "from your data" and neither is promoted into the
            other. The count only makes the existing distinction countable. */}
        <div className="flex flex-col gap-1.5 border-t border-black/[.06] px-4 py-3 dark:border-white/[.08]">
          <div data-testid="map-key" className="flex flex-wrap items-center gap-x-5 gap-y-2">
            {MAP_KEY.map((item) => (
              <span
                key={item.state}
                data-key-state={item.state}
                className="inline-flex items-center gap-2 text-[13px] leading-none"
              >
                <i
                  aria-hidden="true"
                  data-key-swatch
                  className="inline-block h-2.5 w-2.5 shrink-0 rounded-full border-[1.6px]"
                  style={{
                    background: item.state === "unknown" ? "var(--map-surface)" : certaintyColor(item.state),
                    borderColor: certaintyColor(item.state),
                  }}
                />
                <span data-key-count className="font-semibold tabular-nums text-[var(--map-ink)]">
                  {stateCounts[item.state]}
                </span>
                <span className="text-[var(--map-soft)]">{item.label}</span>
              </span>
            ))}
          </div>
          {/* YOUR DATA, native to the map rather than a badge over it. */}
          <p className="text-[11px] text-[var(--map-soft)]">
            {open === null
              ? "This is your business data. J4 organises it for you."
              : `${domain?.label ?? ""} — what J4 has gathered about your business.`}
          </p>
        </div>
      </div>
    </section>
  );
}
