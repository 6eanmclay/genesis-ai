"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { BusinessMap, Certainty, MapDomainKey } from "@/lib/businessModel/businessMap";
import { entitiesFor, type MapProspect } from "@/lib/businessModel/mapEntities";
import { GENESIS_AVATAR_SIZE } from "@/lib/dashboard/genesisAvatarSize";
import { GenesisAvatar } from "./GenesisAvatar";
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

const DOMAIN_ORDER: MapDomainKey[] = [
  "business", "commerce", "customers", "financials", "goals",
  "social", "connections", "creation", "learned",
];

interface Geometry {
  w: number; h: number; cx: number; cy: number;
  /** Radius of the ring of domains around the orb. */
  ring: number; ringSquash: number;
  /** Where an edge starts — the orb's rim, in viewBox units. */
  hub: number;
  dot: number;
  label: number; sub: number; gap: number;
  hit: number;
}

const WIDE: Geometry = {
  w: 900, h: 560, cx: 450, cy: 280,
  ring: 258, ringSquash: 0.66,
  hub: 62, dot: 9, label: 16, sub: 12.5, gap: 18, hit: 30,
};

// Not a shrunken copy: a tighter ring with LARGER type, its radius set by the
// longest label so "Connections" cannot clip to "onnections".
const NARROW: Geometry = {
  w: 460, h: 430, cx: 230, cy: 215,
  ring: 118, ringSquash: 0.92,
  hub: 42, dot: 7, label: 15, sub: 11.5, gap: 11, hit: 22,
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

  /** The nine branches, placed. Computed once — there is only one ring now. */
  const ring = useMemo<Placed[]>(() => {
    const keys = DOMAIN_ORDER;
    return keys.map((key, i) => {
      const d = map.domains.find((x) => x.key === key)!;
      const angle = (i / keys.length) * Math.PI * 2 - Math.PI / 2;
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
        .business-map {
          --map-known: #1f6b4c;
          --map-inferred: #1b5fc4;
          --map-unknown: #8c959b;
          --map-ink: #12181c;
          --map-soft: #5b666d;
          --map-surface: #ffffff;
          --map-ground: #f7f9f9;
          --map-stream: #1b5fc4;
        }
        @media (prefers-color-scheme: dark) {
          .business-map {
            --map-known: #5fb98f;
            --map-inferred: #7fadf5;
            --map-unknown: #78838a;
            --map-ink: #e6ebed;
            --map-soft: #a5b0b6;
            --map-surface: #0b1013;
            --map-ground: #0a0e11;
            --map-stream: #7fadf5;
          }
        }
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
                return (
                  <line key={`e-${c.key}`}
                    x1={G.cx + (dx / len) * G.hub} y1={G.cy + (dy / len) * G.hub}
                    x2={c.x} y2={c.y}
                    stroke={certaintyColor(c.certainty)}
                    strokeWidth={c.certainty === "unknown" ? 1 : 1.6}
                    strokeDasharray={c.certainty === "unknown" ? "4 5" : undefined}
                    opacity={c.certainty === "unknown" ? 0.4 : 0.5}
                  />
                );
              })}

              {ring.map((c) => {
                const right = c.x > G.cx + 1;
                const centred = Math.abs(c.x - G.cx) <= 1;
                const anchor = centred ? "middle" : right ? "start" : "end";
                const dx = centred ? 0 : right ? G.gap : -G.gap;
                const dy = centred ? (c.y > G.cy ? G.label * 1.9 : -G.label * 1.4) : 0;
                return (
                  <g key={c.key} className={open ? undefined : "hit"}
                    role={open ? undefined : "button"}
                    tabIndex={open ? undefined : 0}
                    data-level="child"
                    aria-label={open ? undefined : `${c.label}, ${c.sub}`}
                    onClick={open ? undefined : () => step(c.key)}
                    onKeyDown={(e) => {
                      if (open) return;
                      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); step(c.key); }
                    }}
                  >
                    {!open && <circle cx={c.x} cy={c.y} r={G.hit} fill="transparent" />}
                    <circle cx={c.x} cy={c.y} r={G.dot}
                      fill={c.certainty === "unknown" ? "var(--map-surface)" : certaintyColor(c.certainty)}
                      stroke={certaintyColor(c.certainty)} strokeWidth={1.6} />
                    {/* LABELS ONLY WHERE THEY CAN BE READ. Behind the carousel
                        the ring is structure, not text — 2.2x type sliding
                        under a card is noise, and half of it would be off the
                        stage anyway. */}
                    {!open && (
                      <>
                        <text x={c.x + dx} y={c.y + dy - 1} textAnchor={anchor}
                          fill="var(--map-ink)" fontSize={G.label} fontWeight={600}>
                          {c.label.length > 15 ? `${c.label.slice(0, 14)}…` : c.label}
                        </text>
                        <text x={c.x + dx} y={c.y + dy + G.label * 1.05} textAnchor={anchor}
                          fill="var(--map-soft)" fontSize={G.sub}>
                          {c.sub.length > 18 ? `${c.sub.slice(0, 17)}…` : c.sub}
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
            <span
              aria-hidden="true"
              className={`block rounded-full ${open ? "h-7 w-7" : "h-16 w-16"}`}
              style={{
                background:
                  "radial-gradient(circle at 38% 34%, var(--map-ink) 0%, var(--map-soft) 42%, transparent 72%)",
                opacity: 0.55,
              }}
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

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-black/[.06] px-4 py-2.5 text-[11px] text-[var(--map-soft)] dark:border-white/[.08]">
          <span className="inline-flex items-center gap-1.5">
            <i className="inline-block h-2 w-2 rounded-full" style={{ background: "var(--map-known)" }} />
            from your data
          </span>
          <span className="inline-flex items-center gap-1.5">
            <i className="inline-block h-2 w-2 rounded-full" style={{ background: "var(--map-inferred)" }} />
            J4 worked it out
          </span>
          <span className="inline-flex items-center gap-1.5">
            <i className="inline-block h-2 w-2 rounded-full border border-current" />
            not known yet
          </span>
          {/* YOUR DATA, native to the map rather than a badge over it. */}
          <span className="ml-auto">
            {open === null
              ? "This is your business data. J4 organises it for you."
              : `${domain?.label ?? ""} — what J4 has gathered about your business.`}
          </span>
        </div>
      </div>
    </section>
  );
}
