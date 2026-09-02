"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BusinessMap, Certainty, MapDomainKey } from "@/lib/businessModel/businessMap";
import { branchesFor, type MapBranch, type MapProspect } from "@/lib/businessModel/mapBranches";
import { MapDataStream } from "./MapDataStream";

// THE BUSINESS AS A NETWORK YOU CAN GO INSIDE.
//
// ============ ZOOM IS THE LEVEL OF UNDERSTANDING (2026-09-01) ==========
//
// Sean: "Zoomed out: J4 + the whole business. One level in: J4 + one business
// domain. Another level in: entities within that domain... The map should feel
// like the user is exploring their business from the inside, not navigating a
// conventional sitemap."
//
// So the transform is not a viewer control that happens to exist — it IS the
// navigation. Selecting a branch zooms toward it and reveals the layer beneath;
// stepping back zooms out. The ring never disappears while you are inside it,
// dimmed but present, so it always reads as one network rather than a stack of
// screens.
//
//   depth 0   the ring, J4 at the centre
//   depth 1   one domain, its middle layer fanned out
//   depth 2   one branch, its individual things
//
// ============ EVERY NODE IS SOMETHING THAT EXISTS =====================
//
// Branches come from lib/businessModel/mapBranches.ts, which groups the
// assembler's own nodes and adds prospects the server supplies from real
// registries. Nothing is drawn here that no row or registry stands behind, and
// an unconnected prospect has no children — inventing "Content → Engagement"
// under a disconnected account is precisely the pretence this refuses.
//
// ============ AND THE THREE STATES SURVIVE EVERY LEVEL ================
//
// known / inferred / unknown carry through domains, branches and leaves. An
// empty branch stays on the map saying "not known yet", which is what lets an
// owner watch their understanding fill in over time.

const DOMAIN_ORDER: MapDomainKey[] = [
  "business", "commerce", "customers", "financials", "goals",
  "social", "connections", "creation", "learned",
];

interface Geometry {
  w: number; h: number; cx: number; cy: number;
  rx: number; ry: number;
  hub: number; dot: number;
  label: number; sub: number; gap: number;
  child: number; childDot: number; childLabel: number; childHit: number;
}

const WIDE: Geometry = {
  w: 900, h: 560, cx: 450, cy: 280, rx: 300, ry: 186,
  hub: 46, dot: 9, label: 16, sub: 12.5, gap: 18,
  child: 92, childDot: 6, childLabel: 12.5, childHit: 20,
};

// Not a shrunken copy: a tighter ring with LARGER type, its radius set by the
// longest label so "Connections" cannot clip to "onnections".
const NARROW: Geometry = {
  w: 460, h: 430, cx: 230, cy: 215, rx: 112, ry: 122,
  hub: 32, dot: 7, label: 15.5, sub: 12, gap: 12,
  child: 66, childDot: 5, childLabel: 11, childHit: 13,
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

function certaintyWord(c: Certainty): string {
  if (c === "known") return "from your data";
  if (c === "inferred") return "J4 worked this out";
  return "not known yet";
}

interface Placed extends MapBranch {
  x: number;
  y: number;
}

export function BusinessMapCanvas({
  map,
  services,
  prospects,
  destinations,
}: {
  map: BusinessMap;
  services: MapService[];
  prospects: Partial<Record<MapDomainKey, MapProspect[]>>;
  destinations: Partial<Record<MapDomainKey, DomainDestination>>;
}) {
  /** [domainKey, branchId?, leafId?] — the whole navigation state. */
  const [path, setPath] = useState<string[]>([]);
  const [narrow, setNarrow] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(true);
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

  const activeDomain = path[0] ? domains.find((d) => d.key === path[0]) ?? null : null;

  const branches = useMemo(
    () => (activeDomain ? branchesFor(activeDomain, prospects[activeDomain.key] ?? []) : []),
    [activeDomain, prospects],
  );

  /** Fan a set of nodes out from a parent, away from the hub. */
  const fan = useCallback(
    (from: { x: number; y: number; angle: number }, items: MapBranch[], radius: number): Placed[] => {
      const spread = Math.min(1.1, 0.32 * Math.max(1, items.length - 1));
      return items.map((b, i) => {
        const t = items.length === 1 ? 0 : (i / (items.length - 1)) * 2 - 1;
        const a = from.angle + t * spread;
        return { ...b, x: from.x + Math.cos(a) * radius, y: from.y + Math.sin(a) * radius * 0.78 };
      });
    },
    [],
  );

  const placedBranches = useMemo(
    () => (activeDomain ? fan(activeDomain, branches.slice(0, 6), G.child) : []),
    [activeDomain, branches, fan, G],
  );

  const activeBranch = path[1] ? placedBranches.find((b) => b.id === path[1]) ?? null : null;

  const placedLeaves = useMemo(() => {
    if (!activeBranch || !activeDomain) return [];
    const angle = Math.atan2(activeBranch.y - activeDomain.y, activeBranch.x - activeDomain.x);
    return fan({ ...activeBranch, angle }, activeBranch.children.slice(0, 6), G.child * 0.75);
  }, [activeBranch, activeDomain, fan, G]);

  const activeLeaf = path[2] ? placedLeaves.find((l) => l.id === path[2]) ?? null : null;

  // ---- zoom follows depth, which is the whole navigation idea -------------
  const view = useMemo(() => {
    const target = activeLeaf ?? activeBranch ?? activeDomain;
    if (!target) return { scale: 1, x: G.cx, y: G.cy };
    // Halfway between the hub and the focus, so J4 stays in frame — the point
    // is that you are inside J4's understanding, not that you left it.
    const scale = path.length >= 3 ? 2.1 : path.length === 2 ? 1.7 : 1.35;
    return { scale, x: (G.cx + target.x) / 2, y: (G.cy + target.y) / 2 };
  }, [activeDomain, activeBranch, activeLeaf, path.length, G]);

  const service = useMemo(() => {
    const id = (activeLeaf ?? activeBranch)?.serviceId;
    return id ? services.find((s) => s.id === id) ?? null : null;
  }, [activeBranch, activeLeaf, services]);

  const card = useMemo(() => {
    const node = activeLeaf ?? activeBranch;
    if (node) {
      return {
        title: node.label,
        state: node.state,
        body: node.detail ?? "",
        certainty: node.certainty,
        destination: service?.connected
          ? service.manage ?? destinations[activeDomain!.key] ?? null
          : destinations[activeDomain!.key] ?? null,
        service,
      };
    }
    if (activeDomain) {
      return {
        title: activeDomain.label,
        state: activeDomain.certainty === "unknown" ? "Not yet known" : certaintyWord(activeDomain.certainty),
        body: activeDomain.summary,
        certainty: activeDomain.certainty,
        destination: destinations[activeDomain.key] ?? null,
        service: null as MapService | null,
      };
    }
    return null;
  }, [activeDomain, activeBranch, activeLeaf, destinations, service]);

  // ============ THE CARD RUNS FROM WHERE J4 ACTUALLY IS ==============
  //
  // It used to be placed from the selected node's MODEL coordinates, which was
  // right until the world started zooming: once the view translates, J4's
  // position on screen moves, and the card sat on top of him. The hub's
  // post-transform position is what matters, so it is computed here and the
  // card takes the opposite corner.
  const cardSide = useMemo(() => {
    if (!activeDomain) return { left: false, top: false };
    const hubX = G.cx + view.scale * (G.cx - view.x) + pan.x;
    const hubY = G.cy + view.scale * (G.cy - view.y) + pan.y;
    return { left: hubX > G.w / 2, top: hubY > G.h / 2 };
  }, [activeDomain, view, pan, G]);

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

  /** One step out. The back button and the card's close do the same thing. */
  const stepOut = useCallback(() => {
    setPan({ x: 0, y: 0 });
    setPath((p) => p.slice(0, -1));
  }, []);

  const goTo = useCallback((next: string[]) => {
    if (drag.current?.moved) return;
    setPan({ x: 0, y: 0 });
    setPath(next);
  }, []);

  const dim = (key: MapDomainKey) => (path[0] && path[0] !== key ? 0.16 : 1);

  const here = activeLeaf?.label ?? activeBranch?.label ?? activeDomain?.label ?? null;

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
        .business-map .map-world { transition: transform 320ms cubic-bezier(.2,.7,.3,1); }
        @media (prefers-reduced-motion: reduce) {
          .business-map .map-world { transition: none; }
        }
        @media (prefers-reduced-motion: no-preference) {
          .business-map .node-in { animation: mapNodeIn 240ms ease-out both; }
          @keyframes mapNodeIn { from { opacity: 0 } to { opacity: 1 } }
        }
      `}</style>

      <div className="overflow-hidden rounded-2xl border border-black/[.07] bg-[var(--map-ground)] dark:border-white/[.10]">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-black/[.06] px-4 py-2.5 dark:border-white/[.08]">
          {/* WHERE YOU ARE, as a trail rather than a title — the point is that
              you are inside one network, not on a page. */}
          <p className="flex flex-wrap items-center gap-1 text-xs text-[var(--map-soft)]">
            <button
              type="button"
              onClick={() => goTo([])}
              className={path.length === 0 ? "font-medium text-[var(--map-inferred)]" : "underline underline-offset-2"}
            >J4</button>
            {[activeDomain?.label, activeBranch?.label, activeLeaf?.label].map((label, i) =>
              label ? (
                <span key={i} className="flex items-center gap-1">
                  <span aria-hidden>›</span>
                  <button
                    type="button"
                    onClick={() => goTo(path.slice(0, i + 1))}
                    className={i === path.length - 1 ? "font-medium text-[var(--map-ink)]" : "underline underline-offset-2"}
                  >{label}</button>
                </span>
              ) : null,
            )}
            {path.length === 0 && <span className="ml-1">— tap a branch to go inside</span>}
          </p>
          <div className="flex items-center gap-1">
            <button
              type="button" onClick={stepOut} disabled={path.length === 0}
              data-testid="map-back"
              className="rounded-full border border-black/[.08] px-2.5 py-1 text-[11px] text-[var(--map-soft)] disabled:opacity-40 dark:border-white/[.145]"
            >Back</button>
            <button
              type="button" onClick={() => goTo([])}
              className="rounded-full border border-black/[.08] px-2.5 py-1 text-[11px] text-[var(--map-soft)] dark:border-white/[.145]"
            >Whole business</button>
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
            <g
              className="map-world"
              data-testid="map-world"
              transform={`translate(${pan.x} ${pan.y}) translate(${G.cx} ${G.cy}) scale(${view.scale}) translate(${-view.x} ${-view.y})`}
            >
              {domains.map((d) => {
                const focused = path[0] === d.key;
                return (
                  <line
                    key={`edge-${d.key}`}
                    x1={G.cx} y1={G.cy} x2={d.x} y2={d.y}
                    stroke={certaintyColor(d.certainty)}
                    strokeWidth={focused ? 2.4 : d.certainty === "unknown" ? 1 : 1.6}
                    strokeDasharray={d.certainty === "unknown" && !focused ? "4 5" : undefined}
                    opacity={(d.certainty === "unknown" ? 0.45 : 0.55) * dim(d.key)}
                  />
                );
              })}

              {activeDomain && placedBranches.map((b) => (
                <line
                  key={`bedge-${b.id}`} className="node-in"
                  x1={activeDomain.x} y1={activeDomain.y} x2={b.x} y2={b.y}
                  stroke={certaintyColor(b.certainty)} strokeWidth={1.1}
                  strokeDasharray={b.certainty === "unknown" ? "3 4" : undefined}
                  opacity={path[1] && path[1] !== b.id ? 0.18 : 0.5}
                />
              ))}
              {activeBranch && placedLeaves.map((l) => (
                <line
                  key={`ledge-${l.id}`} className="node-in"
                  x1={activeBranch.x} y1={activeBranch.y} x2={l.x} y2={l.y}
                  stroke={certaintyColor(l.certainty)} strokeWidth={0.9}
                  opacity={0.45}
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
                const focused = path[0] === d.key;
                const open = () => goTo(focused ? [] : [d.key]);
                return (
                  <g
                    key={d.key} className="hit" role="button" tabIndex={0}
                    aria-pressed={focused}
                    aria-label={`${d.label}: ${d.summary}`}
                    opacity={dim(d.key)}
                    onClick={open}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
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

              {activeDomain && placedBranches.map((b) => {
                const selected = path[1] === b.id;
                const right = b.x >= activeDomain.x;
                const open = () => goTo(selected ? [activeDomain.key] : [activeDomain.key, b.id]);
                return (
                  <g
                    key={`branch-${b.id}`} className="hit node-in" data-level="branch"
                    role="button" tabIndex={0}
                    aria-pressed={selected}
                    aria-label={`${b.label}, ${b.state}`}
                    opacity={path[1] && !selected ? 0.3 : 1}
                    onClick={open}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
                    }}
                  >
                    <circle cx={b.x} cy={b.y} r={G.childHit} fill="transparent" />
                    {selected && (
                      <circle cx={b.x} cy={b.y} r={G.childDot * 2.4} fill="none"
                        stroke={certaintyColor(b.certainty)} strokeWidth={1.25} opacity={0.6} />
                    )}
                    <circle cx={b.x} cy={b.y} r={G.childDot}
                      fill={b.certainty === "unknown" ? "var(--map-surface)" : certaintyColor(b.certainty)}
                      stroke={certaintyColor(b.certainty)} strokeWidth={1.4} />
                    <text x={b.x + (right ? 10 : -10)} y={b.y + 3.5}
                      textAnchor={right ? "start" : "end"}
                      fill="var(--map-ink)" fontSize={G.childLabel}>
                      {b.label.length > 16 ? `${b.label.slice(0, 15)}…` : b.label}
                    </text>
                  </g>
                );
              })}

              {activeBranch && placedLeaves.map((l) => {
                const selected = path[2] === l.id;
                const right = l.x >= activeBranch.x;
                const open = () =>
                  goTo(selected ? [activeDomain!.key, activeBranch.id] : [activeDomain!.key, activeBranch.id, l.id]);
                return (
                  <g
                    key={`leaf-${l.id}`} className="hit node-in" data-level="leaf"
                    role="button" tabIndex={0}
                    aria-pressed={selected}
                    aria-label={`${l.label}, ${l.state}`}
                    onClick={open}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
                    }}
                  >
                    <circle cx={l.x} cy={l.y} r={G.childHit} fill="transparent" />
                    <circle cx={l.x} cy={l.y} r={G.childDot * 0.85}
                      fill={l.certainty === "unknown" ? "var(--map-surface)" : certaintyColor(l.certainty)}
                      stroke={certaintyColor(l.certainty)} strokeWidth={1.2} />
                    <text x={l.x + (right ? 8 : -8)} y={l.y + 3}
                      textAnchor={right ? "start" : "end"}
                      fill="var(--map-soft)" fontSize={G.childLabel * 0.92}>
                      {l.label.length > 14 ? `${l.label.slice(0, 13)}…` : l.label}
                    </text>
                  </g>
                );
              })}
            </g>
          </svg>

          {card && (
            <div
              data-testid="map-card"
              // ============ IT FLOATS, IT DOES NOT BLOCK ==============
              //
              // The card sits over the drawing, and on a phone the branches fan
              // into the space it occupies -- so it was swallowing taps meant
              // for nodes underneath it. A node you can see and cannot tap is
              // worse than one that is covered.
              //
              // The container takes no pointer events; only its own controls
              // do. What it costs is selecting the body text, which nothing
              // needs; what it buys is that the map stays fully usable with a
              // card open.
              className="pointer-events-none absolute z-10 max-w-[62%] rounded-xl border border-black/[.10] bg-[var(--map-surface)]/95 p-2.5 shadow-lg backdrop-blur-sm sm:max-w-[15rem] sm:p-3 dark:border-white/[.14]"
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
                  type="button" data-testid="map-card-close" onClick={stepOut} aria-label="Close"
                  className="pointer-events-auto -mr-1 -mt-1 shrink-0 rounded px-1 text-sm leading-none text-[var(--map-soft)]"
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
                      className="pointer-events-auto rounded-full border border-black/[.14] px-2.5 py-1 text-[11px] font-medium text-[var(--map-ink)] dark:border-white/[.22]"
                    >Connect</Link>
                    {card.service.signupUrl ? (
                      <a href={card.service.signupUrl} target="_blank" rel="noopener noreferrer"
                        className="pointer-events-auto px-1 text-[11px] text-[var(--map-soft)] underline underline-offset-2">Create</a>
                    ) : (
                      <span className="text-[11px] text-[var(--map-soft)]">No signup link we could verify.</span>
                    )}
                  </>
                )}
                {card.destination && !(card.service && !card.service.connected && card.service.available) && (
                  <Link
                    href={card.destination.href}
                    data-testid="map-view-link"
                    className="pointer-events-auto rounded-full bg-[var(--map-inferred)] px-2.5 py-1 text-[11px] font-medium text-white"
                  >{card.destination.label}</Link>
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
          {/* YOUR DATA, native to the map rather than a badge over it. */}
          <span className="ml-auto">
            {here ? `${here} — your data, organised by J4.` : "This is your business data. J4 organises it for you."}
          </span>
        </div>
      </div>
    </section>
  );
}
