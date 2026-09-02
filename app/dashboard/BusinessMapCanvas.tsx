"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BusinessMap, Certainty, MapDomainKey, MapNode } from "@/lib/businessModel/businessMap";
import { MapDataStream } from "./MapDataStream";

// THE FRONT DOOR: WHAT J4 UNDERSTANDS, AS SOMETHING YOU CAN EXPLORE.
//
// ============ THE MAP RESPONDS, RATHER THAN OPENING A PANEL (2026-09-01)
//
// Sean: "I don't want tapping a branch to simply create a large panel
// underneath the diagram. I want the map itself to respond to selection."
//
// So selection is a state OF THE DRAWING. Focusing Social dims every other
// branch, thickens the line from J4 to Social, and reveals Social's children on
// an arc beyond it. The information appears in a compact bubble anchored to the
// selection and placed on the FAR SIDE of the stage from it, so it never covers
// the thing that was just tapped.
//
// ============ THE THREE STATES ARE THE POINT ==========================
//
// known / inferred / unknown are never collapsed for visual tidiness. An empty
// branch stays on the map, dashed and hollow, saying "not known yet" — because
// a branch that vanished when empty would make "J4 knows nothing about your
// social reach" indistinguishable from "you have no social reach", and only the
// first is something an owner can fix.
//
// It is also what makes the map grow visibly: a branch that reads unknown today
// becomes a real one in place, and the change is the point rather than a side
// effect.
//
// ============ AND EVERY RELATIONSHIP IS REAL ==========================
//
// Children come from the assembler's own nodes, which exist only where a row
// does. Nothing here invents a child to make a branch look populated.

const DOMAIN_ORDER: MapDomainKey[] = [
  "business", "commerce", "customers", "financials", "goals",
  "social", "connections", "creation", "learned",
];

// ============ GEOMETRY IS RESPONSIVE, AND IT HAD TO BE ================
//
// The first version used one wide viewBox for every screen. Every geometry
// assertion passed and the phone screenshot showed branch labels at roughly six
// pixels. The narrow geometry is not a shrunken copy — it is a tighter ring
// with larger type, and its radius is set by the longest label so
// "Connections" cannot clip to "onnections".
interface Geometry {
  w: number; h: number; cx: number; cy: number;
  rx: number; ry: number;
  hub: number; dot: number;
  label: number; sub: number; gap: number;
  child: number; childDot: number; childLabel: number;
  /** Tap target for a child. Must be smaller than the gap between two of them. */
  childHit: number;
}

const WIDE: Geometry = {
  w: 900, h: 560, cx: 450, cy: 280, rx: 300, ry: 186,
  hub: 46, dot: 9, label: 16, sub: 12.5, gap: 18,
  child: 92, childDot: 6, childLabel: 12.5, childHit: 20,
};

const NARROW: Geometry = {
  w: 460, h: 430, cx: 230, cy: 215, rx: 112, ry: 122,
  hub: 32, dot: 7, label: 15.5, sub: 12, gap: 12,
  child: 66, childDot: 5, childLabel: 11, childHit: 13,
};

export interface DomainDestination {
  label: string;
  href: string;
}

/** A service the Connections branch can offer. Passed in; never invented here. */
export interface MapService {
  id: string;
  name: string;
  domain: MapDomainKey;
  available: boolean;
  connected: boolean;
  /** The catalogue's own words about what it brings. Never written here. */
  description: string;
  signupUrl: string | null;
  /**
   * Where a CONNECTED service is managed, when that is not the Connections
   * screen.
   *
   * Stripe and PayPal are connected through Payments and are not in the
   * connections catalogue at all — see the section for why they still appear.
   */
  manage: DomainDestination | null;
}

function certaintyColor(c: Certainty): string {
  if (c === "known") return "var(--map-known)";
  if (c === "inferred") return "var(--map-inferred)";
  return "var(--map-unknown)";
}

function certaintyWord(c: Certainty): string {
  if (c === "known") return "from your data";
  if (c === "inferred") return "J4 worked this out";
  return "not known yet";
}

type Focus = { domain: MapDomainKey; childId: string | null } | null;

interface CardContent {
  title: string;
  state: string;
  body: string;
  certainty: Certainty;
  destination: DomainDestination | null;
  service: MapService | null;
}

export function BusinessMapCanvas({
  map,
  services,
  destinations,
}: {
  map: BusinessMap;
  services: MapService[];
  destinations: Partial<Record<MapDomainKey, DomainDestination>>;
}) {
  const [focus, setFocus] = useState<Focus>(null);
  const [narrow, setNarrow] = useState(false);
  // Defaults to REDUCED until the client says otherwise, so a server render and
  // a viewer who asked for no motion both start still rather than moving first.
  const [reducedMotion, setReducedMotion] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; panX: number; panY: number; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);

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

  const domains = useMemo(
    () =>
      DOMAIN_ORDER.map((key, i) => {
        const domain = map.domains.find((d) => d.key === key)!;
        const angle = (i / DOMAIN_ORDER.length) * Math.PI * 2 - Math.PI / 2;
        return {
          ...domain,
          x: G.cx + Math.cos(angle) * G.rx,
          y: G.cy + Math.sin(angle) * G.ry,
          angle,
        };
      }),
    [map.domains, G],
  );

  const active = focus ? domains.find((d) => d.key === focus.domain) ?? null : null;

  /**
   * What sits under the focused branch.
   *
   * Connections is the one domain whose children are SERVICES rather than
   * records — it is the gateway, and a connected service genuinely is what J4
   * knows about that branch. Every other domain shows its own nodes.
   */
  const children = useMemo(() => {
    type Child = { id: string; label: string; certainty: Certainty; node: MapNode | null; service: MapService | null };
    if (!active) return [] as Child[];
    if (active.key === "connections") {
      const ordered = [...services].sort(
        (a, b) => Number(b.connected) - Number(a.connected) || Number(b.available) - Number(a.available),
      );
      return ordered.slice(0, 5).map<Child>((s) => ({
        id: `service:${s.id}`,
        label: s.name,
        certainty: s.connected ? "known" : "unknown",
        node: null,
        service: s,
      }));
    }
    return active.nodes.slice(0, 5).map<Child>((n) => ({
      id: n.id,
      label: n.label,
      certainty: n.certainty,
      node: n,
      service: null,
    }));
  }, [active, services]);

  /** Children fan out beyond the focused branch, away from the hub. */
  const placedChildren = useMemo(() => {
    if (!active) return [];
    const spread = Math.min(1.1, 0.32 * Math.max(1, children.length - 1));
    return children.map((c, i) => {
      const t = children.length === 1 ? 0 : (i / (children.length - 1)) * 2 - 1;
      const a = active.angle + t * spread;
      return {
        ...c,
        x: active.x + Math.cos(a) * G.child,
        y: active.y + Math.sin(a) * G.child * 0.78,
      };
    });
  }, [active, children, G]);

  const card: CardContent | null = useMemo(() => {
    if (!active) return null;
    const child = focus?.childId ? placedChildren.find((c) => c.id === focus.childId) ?? null : null;

    if (child?.service) {
      const s = child.service;
      return {
        title: s.name,
        state: s.connected ? "Connected" : s.available ? "Not connected" : "Genesis cannot connect this yet",
        // THE CATALOGUE'S OWN WORDS. Sean: "The exact copy should be based on
        // capabilities that actually exist or are explicitly planned. Do not
        // claim data J4 cannot currently access." That text is written per
        // provider and already carries its own caveats — TikTok's says
        // demographics are not available through its API.
        body: s.connected ? `J4 uses this in your Business Map. ${s.description}` : s.description,
        certainty: s.connected ? "known" : "unknown",
        destination: destinations.connections ?? null,
        service: s,
      };
    }
    if (child?.node) {
      const n = child.node;
      return {
        title: n.label,
        state: certaintyWord(n.certainty),
        body: n.detail ?? "",
        certainty: n.certainty,
        destination: destinations[active.key] ?? null,
        service: null,
      };
    }
    return {
      title: active.label,
      state: active.certainty === "unknown" ? "Not yet known" : certaintyWord(active.certainty),
      body: active.summary,
      certainty: active.certainty,
      destination: destinations[active.key] ?? null,
      service: null,
    };
  }, [active, focus, placedChildren, destinations]);

  // The bubble sits on the far side of the stage from the selected node, then
  // is clamped by the stage's own padding — anchored to the selection without
  // ever covering it.
  const cardSide = useMemo(() => {
    if (!active) return { left: false, top: false };
    return { left: active.x > G.cx, top: active.y > G.cy };
  }, [active, G]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y, moved: false };
    setDragging(true);
  }, [pan.x, pan.y]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (Math.abs(e.clientX - d.x) > 3 || Math.abs(e.clientY - d.y) > 3) d.moved = true;
    setPan({ x: d.panX + (e.clientX - d.x), y: d.panY + (e.clientY - d.y) });
  }, []);

  const endDrag = useCallback(() => {
    drag.current = null;
    setDragging(false);
  }, []);

  const nudgeZoom = useCallback((by: number) => {
    setZoom((z) => Math.min(2.2, Math.max(0.6, Math.round((z + by) * 20) / 20)));
  }, []);

  const reset = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setFocus(null);
  }, []);

  const dim = (key: MapDomainKey) => (focus && focus.domain !== key ? 0.22 : 1);

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
            --map-surface: #12181c;
            --map-ground: #0e1316;
            --map-stream: #7fadf5;
          }
        }
        .business-map .map-stage { touch-action: none; }
        .business-map .hit { cursor: pointer; }
        .business-map .hit:focus-visible { outline: 2px solid var(--map-inferred); outline-offset: 3px; }
        @media (prefers-reduced-motion: no-preference) {
          .business-map .node-in { animation: mapNodeIn 240ms ease-out both; }
          @keyframes mapNodeIn { from { opacity: 0 } to { opacity: 1 } }
        }
      `}</style>

      <div className="overflow-hidden rounded-2xl border border-black/[.07] bg-[var(--map-ground)] dark:border-white/[.10]">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-black/[.06] px-4 py-2.5 dark:border-white/[.08]">
          <p className="text-xs text-[var(--map-soft)]">
            {focus
              ? "Tap a node to look closer. Tap the branch again to step back."
              : "Tap a branch to explore it. Drag to move, or zoom with the buttons."}
          </p>
          <div className="flex items-center gap-1">
            <button type="button" onClick={() => nudgeZoom(-0.2)} aria-label="Zoom out"
              className="h-7 w-7 rounded-full border border-black/[.08] text-sm text-[var(--map-soft)] dark:border-white/[.145]">−</button>
            <button type="button" onClick={() => nudgeZoom(0.2)} aria-label="Zoom in"
              className="h-7 w-7 rounded-full border border-black/[.08] text-sm text-[var(--map-soft)] dark:border-white/[.145]">+</button>
            <button type="button" onClick={reset}
              className="ml-1 rounded-full border border-black/[.08] px-2.5 py-1 text-[11px] text-[var(--map-soft)] dark:border-white/[.145]">Reset</button>
          </div>
        </div>

        <div
          className="map-stage relative h-[320px] w-full select-none overflow-hidden bg-[var(--map-surface)] sm:h-[400px] lg:h-[460px]"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          style={{ cursor: dragging ? "grabbing" : "grab" }}
        >
          <MapDataStream reducedMotion={reducedMotion} />

          <svg
            viewBox={`0 0 ${G.w} ${G.h}`}
            className="relative h-full w-full"
            role="img"
            aria-label={`J4 at the centre with ${domains.length} branches: ${domains
              .map((d) => `${d.label}, ${certaintyWord(d.certainty)}`)
              .join("; ")}`}
          >
            <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom}) translate(${(G.cx * (1 - zoom)) / zoom} ${(G.cy * (1 - zoom)) / zoom})`}>
              {domains.map((d) => {
                const focused = focus?.domain === d.key;
                return (
                  <line
                    key={`edge-${d.key}`}
                    x1={G.cx} y1={G.cy} x2={d.x} y2={d.y}
                    stroke={certaintyColor(d.certainty)}
                    strokeWidth={focused ? 3 : d.certainty === "unknown" ? 1 : 1.75}
                    strokeDasharray={d.certainty === "unknown" && !focused ? "4 5" : undefined}
                    opacity={(d.certainty === "unknown" ? 0.45 : 0.55) * dim(d.key)}
                  />
                );
              })}

              {active && placedChildren.map((c) => (
                <line
                  key={`childedge-${c.id}`}
                  className="node-in"
                  x1={active.x} y1={active.y} x2={c.x} y2={c.y}
                  stroke={certaintyColor(c.certainty)} strokeWidth={1.1}
                  strokeDasharray={c.certainty === "unknown" ? "3 4" : undefined}
                  opacity={0.5}
                />
              ))}

              <circle cx={G.cx} cy={G.cy} r={G.hub} fill="var(--map-surface)" stroke="var(--map-inferred)" strokeWidth={1.75} />
              <text x={G.cx} y={G.cy + G.hub * 0.16} textAnchor="middle"
                fill="var(--map-inferred)" fontSize={G.hub * 0.44} fontWeight={600}>J4</text>

              {domains.map((d) => {
                const right = Math.cos(d.angle) > 0.12;
                const centred = Math.abs(Math.cos(d.angle)) <= 0.12;
                const anchor = centred ? "middle" : right ? "start" : "end";
                const dx = centred ? 0 : right ? G.gap : -G.gap;
                const dy = centred ? (Math.sin(d.angle) > 0 ? G.label * 2.1 : -G.label * 1.6) : 0;
                const focused = focus?.domain === d.key;
                const toggle = () => {
                  if (drag.current?.moved) return;
                  setFocus(focused ? null : { domain: d.key, childId: null });
                };
                return (
                  <g
                    key={d.key}
                    className="hit"
                    role="button"
                    tabIndex={0}
                    aria-pressed={focused}
                    aria-label={`${d.label}: ${d.summary}`}
                    opacity={dim(d.key)}
                    onClick={toggle}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        toggle();
                      }
                    }}
                  >
                    <circle cx={d.x} cy={d.y} r={Math.max(26, G.dot * 3.4)} fill="transparent" />
                    {focused && (
                      <circle cx={d.x} cy={d.y} r={G.dot * 2.2} fill="none"
                        stroke={certaintyColor(d.certainty)} strokeWidth={1.5} opacity={0.55} />
                    )}
                    <circle cx={d.x} cy={d.y} r={G.dot}
                      fill={d.certainty === "unknown" ? "var(--map-surface)" : certaintyColor(d.certainty)}
                      stroke={certaintyColor(d.certainty)} strokeWidth={1.75} />
                    <text x={d.x + dx} y={d.y + dy - 1} textAnchor={anchor}
                      fill="var(--map-ink)" fontSize={G.label} fontWeight={600}>{d.label}</text>
                    <text x={d.x + dx} y={d.y + dy + G.label * 1.05} textAnchor={anchor}
                      fill="var(--map-soft)" fontSize={G.sub}>
                      {d.nodes.length > 0 ? `${d.nodes.length}` : "not known yet"}
                    </text>
                  </g>
                );
              })}

              {active && placedChildren.map((c) => {
                const selected = focus?.childId === c.id;
                const right = c.x >= active.x;
                const toggle = () => {
                  if (drag.current?.moved) return;
                  setFocus({ domain: active.key, childId: selected ? null : c.id });
                };
                return (
                  <g
                    key={`childnode-${c.id}`}
                    className="hit node-in"
                    role="button"
                    tabIndex={0}
                    aria-pressed={selected}
                    aria-label={`${c.label}, ${certaintyWord(c.certainty)}`}
                    onClick={toggle}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        toggle();
                      }
                    }}
                  >
                    {/* ============ HIT TARGETS MUST NOT OVERLAP ==========
                        A fixed 22-unit target was wider than the gap between
                        two adjacent children on a phone, so the later-painted
                        node sat on top of its neighbour and the neighbour
                        could not be tapped at all. Sized from the geometry
                        instead, and the browser suite now clicks every child
                        rather than only the first. */}
                    <circle cx={c.x} cy={c.y} r={G.childHit} fill="transparent" />
                    {selected && (
                      <circle cx={c.x} cy={c.y} r={G.childDot * 2.4} fill="none"
                        stroke={certaintyColor(c.certainty)} strokeWidth={1.25} opacity={0.6} />
                    )}
                    <circle cx={c.x} cy={c.y} r={G.childDot}
                      fill={c.certainty === "unknown" ? "var(--map-surface)" : certaintyColor(c.certainty)}
                      stroke={certaintyColor(c.certainty)} strokeWidth={1.4} />
                    <text
                      x={c.x + (right ? 10 : -10)} y={c.y + 3.5}
                      textAnchor={right ? "start" : "end"}
                      fill="var(--map-ink)" fontSize={G.childLabel}
                    >
                      {c.label.length > 16 ? `${c.label.slice(0, 15)}…` : c.label}
                    </text>
                  </g>
                );
              })}
            </g>
          </svg>

          {card && (
            <div
              data-testid="map-card"
              className="absolute z-10 max-w-[62%] rounded-xl border border-black/[.10] bg-[var(--map-surface)]/95 p-2.5 shadow-lg backdrop-blur-sm sm:max-w-[15rem] sm:p-3 dark:border-white/[.14]"
              style={{
                left: cardSide.left ? "0.6rem" : undefined,
                right: cardSide.left ? undefined : "0.6rem",
                top: cardSide.top ? "0.6rem" : undefined,
                bottom: cardSide.top ? undefined : "0.6rem",
              }}
            >
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-semibold leading-tight text-[var(--map-ink)]">{card.title}</p>
                <button
                  type="button"
                  data-testid="map-card-close"
                  onClick={() => setFocus(focus?.childId ? { domain: focus.domain, childId: null } : null)}
                  aria-label="Close"
                  className="-mr-1 -mt-1 shrink-0 rounded px-1 text-sm leading-none text-[var(--map-soft)]"
                >×</button>
              </div>
              <p className="mt-0.5 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-[var(--map-soft)]">
                <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: certaintyColor(card.certainty) }} aria-hidden />
                {card.state}
              </p>
              {card.body && (
                <p className="mt-1.5 line-clamp-2 text-xs leading-snug text-[var(--map-soft)] sm:line-clamp-4">{card.body}</p>
              )}

              <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                {card.service && !card.service.connected && card.service.available && (
                  <>
                    <Link
                      href={destinations.connections?.href ?? "#"}
                      className="rounded-full border border-black/[.14] px-2.5 py-1 text-[11px] font-medium text-[var(--map-ink)] dark:border-white/[.22]"
                    >
                      Connect
                    </Link>
                    {card.service.signupUrl ? (
                      <a
                        href={card.service.signupUrl}
                        target="_blank" rel="noopener noreferrer"
                        className="px-1 text-[11px] text-[var(--map-soft)] underline underline-offset-2"
                      >Create</a>
                    ) : (
                      <span className="text-[11px] text-[var(--map-soft)]">No signup link we could verify.</span>
                    )}
                  </>
                )}
                {/* ONE ROW OF ACTIONS, NOT TWO. A service card already offers
                    Connect, which goes to the same place View Connections
                    would -- and on a phone the third button wrapped the card
                    onto an extra line, growing it until it reached the J4 hub
                    it is supposed to sit clear of. Suppressed where it would
                    only repeat the button beside it.

                    A CONNECTED service links where it is actually managed:
                    Stripe and PayPal are configured in Payments, not in
                    Connections, so sending an owner to Connections for them
                    would be an action that does not fit their state. */}
                {card.service?.connected && card.service.manage ? (
                  <Link
                    href={card.service.manage.href}
                    data-testid="map-view-link"
                    className="rounded-full bg-[var(--map-inferred)] px-2.5 py-1 text-[11px] font-medium text-white"
                  >
                    {card.service.manage.label}
                  </Link>
                ) : card.destination && !(card.service && !card.service.connected && card.service.available) && (
                  <Link
                    href={card.destination.href}
                    data-testid="map-view-link"
                    className="rounded-full bg-[var(--map-inferred)] px-2.5 py-1 text-[11px] font-medium text-white"
                  >
                    {card.destination.label}
                  </Link>
                )}
              </div>
            </div>
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
          {/* YOUR DATA, stated plainly rather than as a badge. */}
          <span className="ml-auto">This is your business data. J4 organises it for you.</span>
        </div>
      </div>
    </section>
  );
}
