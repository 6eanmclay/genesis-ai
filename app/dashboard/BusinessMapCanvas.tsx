"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { BusinessMap, Certainty, MapDomainKey } from "@/lib/businessModel/businessMap";
import { branchesFor, type MapBranch, type MapProspect } from "@/lib/businessModel/mapBranches";
import { MapDataStream } from "./MapDataStream";
import { ConnectionChooser } from "./ConnectionChooser";

// GOING INSIDE THE BUSINESS, ONE LEVEL AT A TIME.
//
// ============ EVERY LEVEL IS LAID OUT FRESH (2026-09-01) ===============
//
// Sean, on the previous build: "Right now selecting a branch mostly
// slides/repositions the network. I want it to actually zoom... The currently
// selected branch becomes the new center of attention."
//
// The old version laid every level out in ONE shared coordinate space and only
// moved a camera over it. Children were placed relative to their parent's
// position out on the ring, so the deeper you went the more they crowded into
// the same pixels — which is exactly the hairball in his screenshots, where
// "Connections" sat on top of "Mailchimp" and "Creation / Assets / Designs"
// stacked on each other.
//
// Those were one bug, not two. A layout that accumulates cannot be zoomed out
// of trouble. So:
//
//   THE FOCUSED NODE IS RE-LAID-OUT TO THE CENTRE, at the size J4 had one
//   level up, and its children ring it at branch size. Nothing inherits a
//   parent's coordinates, so no level can ever crowd another.
//
// ============ AND THE ZOOM IS REAL, NOT A TRANSLATION =================
//
// The world scale genuinely increases with depth on top of the re-layout, so
// the transform's SCALE changes rather than only its translation — the
// difference between going inside something and sliding past it. The browser
// suite asserts the scale factor itself for that reason.
//
// ============ IT STAYS ONE WORLD =====================================
//
// Sean: "Keep J4/context visible in some subtle way as we travel deeper... but
// don't let the old level clutter the new one."
//
// So the level above is drawn as a single faint node with a line to the
// centre, plus the breadcrumb. One mark, not a whole ring — context without
// competition.

const DOMAIN_ORDER: MapDomainKey[] = [
  "business", "commerce", "customers", "financials", "goals",
  "social", "connections", "creation", "learned",
];

interface Geometry {
  w: number; h: number; cx: number; cy: number;
  /** Radius of the ring of children around whatever is centred. */
  ring: number; ringSquash: number;
  hub: number; dot: number;
  label: number; sub: number; gap: number;
  hit: number;
}

const WIDE: Geometry = {
  w: 900, h: 560, cx: 450, cy: 280,
  ring: 258, ringSquash: 0.66,
  hub: 46, dot: 9, label: 16, sub: 12.5, gap: 18, hit: 30,
};

// Not a shrunken copy: a tighter ring with LARGER type, its radius set by the
// longest label so "Connections" cannot clip to "onnections".
const NARROW: Geometry = {
  w: 460, h: 430, cx: 230, cy: 215,
  ring: 118, ringSquash: 0.92,
  hub: 33, dot: 7, label: 15, sub: 11.5, gap: 11, hit: 22,
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

function certaintyWord(c: Certainty): string {
  if (c === "known") return "from your data";
  if (c === "inferred") return "J4 worked this out";
  return "not known yet";
}

/** One thing on the map at the current level. */
interface Placed {
  id: string;
  label: string;
  sub: string;
  certainty: Certainty;
  x: number;
  y: number;
  /** What selecting it means. */
  go: string[];
  serviceId: string | null;
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

  const domain = path[0] ? map.domains.find((d) => d.key === path[0]) ?? null : null;
  const branches = useMemo(
    () => (domain ? branchesFor(domain, prospects[domain.key] ?? []) : []),
    [domain, prospects],
  );
  const branch = path[1] ? branches.find((b) => b.id === path[1]) ?? null : null;
  const leaf = path[2] ? branch?.children.find((c) => c.id === path[2]) ?? null : null;

  /**
   * What is at the centre, and what rings it.
   *
   * Computed FRESH for the current level. This is the whole fix: nothing here
   * reads a position from the level above, so nothing can inherit its crowding.
   */
  const scene = useMemo(() => {
    const ring = (items: Placed[]): Placed[] =>
      items.map((item, i) => {
        const angle = (i / Math.max(1, items.length)) * Math.PI * 2 - Math.PI / 2;
        return {
          ...item,
          x: G.cx + Math.cos(angle) * G.ring,
          y: G.cy + Math.sin(angle) * G.ring * G.ringSquash,
        };
      });

    if (leaf && branch && domain) {
      return {
        centre: { label: leaf.label, certainty: leaf.certainty, sub: leaf.state },
        children: [] as Placed[],
        parent: branch.label,
      };
    }
    if (branch && domain) {
      return {
        centre: { label: branch.label, certainty: branch.certainty, sub: branch.state },
        children: ring(
          branch.children.slice(0, 8).map((c) => ({
            id: c.id, label: c.label, sub: c.state, certainty: c.certainty,
            x: 0, y: 0, go: [domain.key, branch.id, c.id], serviceId: null,
          })),
        ),
        parent: domain.label,
      };
    }
    if (domain) {
      return {
        centre: { label: domain.label, certainty: domain.certainty, sub: domain.summary },
        children: ring(
          branches.slice(0, 8).map((b) => ({
            id: b.id, label: b.label, sub: b.state, certainty: b.certainty,
            x: 0, y: 0, go: [domain.key, b.id], serviceId: b.serviceId,
          })),
        ),
        parent: "J4",
      };
    }
    return {
      centre: { label: "J4", certainty: "known" as Certainty, sub: map.business.name },
      children: ring(
        DOMAIN_ORDER.map((key) => {
          const d = map.domains.find((x) => x.key === key)!;
          return {
            id: d.key, label: d.label,
            sub: d.nodes.length > 0 ? `${d.nodes.length}` : "not known yet",
            certainty: d.certainty, x: 0, y: 0, go: [d.key], serviceId: null,
          };
        }),
      ),
      parent: null,
    };
  }, [domain, branch, leaf, branches, map, G]);

  // ---- depth is a real scale change, not a nudge --------------------------
  const level = path.length;
  const worldScale = 1 + level * 0.3;

  const service = useMemo(() => {
    const id = leaf ? null : branch?.serviceId ?? null;
    return id ? services.find((s) => s.id === id) ?? null : null;
  }, [branch, leaf, services]);

  const card = useMemo(() => {
    // NO CARD FOR CONNECTIONS. Sean: "Remove that card entirely from the map
    // experience. When the user selects Connections, the experience should
    // instead lead naturally into the connection-selection experience."
    if (path[0] === "connections" && path.length === 1) return null;
    if (level === 0) return null;
    return {
      title: scene.centre.label,
      state: leaf?.state ?? branch?.state ?? (domain?.certainty === "unknown" ? "Not yet known" : certaintyWord(scene.centre.certainty)),
      body: leaf?.detail ?? branch?.detail ?? domain?.summary ?? "",
      certainty: scene.centre.certainty,
      destination: service?.connected ? service.manage ?? destinations[path[0] as MapDomainKey] ?? null : destinations[path[0] as MapDomainKey] ?? null,
      service,
    };
  }, [path, level, scene, leaf, branch, domain, destinations, service]);

  const go = useCallback((next: string[]) => {
    // Connections opens the chooser instead of a level.
    if (next.length === 1 && next[0] === "connections") {
      setPath(next);
      setChooserOpen(true);
      return;
    }
    setPath(next);
  }, []);

  const stepOut = useCallback(() => {
    setChooserOpen(false);
    setPath((p) => p.slice(0, -1));
  }, []);

  const reset = useCallback(() => {
    setChooserOpen(false);
    setPath([]);
  }, []);

  const trail = [scene.parent === "J4" || scene.parent === null ? null : null];
  void trail;

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
        .business-map .map-world { transition: transform 380ms cubic-bezier(.22,.7,.24,1); }
        .business-map .lvl { transition: opacity 300ms ease; }
        @media (prefers-reduced-motion: reduce) {
          .business-map .map-world, .business-map .lvl { transition: none; }
        }
      `}</style>

      <div className="overflow-hidden rounded-2xl border border-black/[.07] bg-[var(--map-ground)] dark:border-white/[.10]">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-black/[.06] px-4 py-2.5 dark:border-white/[.08]">
          <p className="flex min-w-0 flex-wrap items-center gap-1 text-xs text-[var(--map-soft)]">
            <button type="button" onClick={reset}
              className={level === 0 ? "font-medium text-[var(--map-inferred)]" : "underline underline-offset-2"}
            >J4</button>
            {[domain?.label, branch?.label, leaf?.label].map((label, i) =>
              label ? (
                <span key={i} className="flex items-center gap-1">
                  <span aria-hidden>›</span>
                  <button type="button" onClick={() => go(path.slice(0, i + 1))}
                    className={i === level - 1 ? "truncate font-medium text-[var(--map-ink)]" : "underline underline-offset-2"}
                  >{label}</button>
                </span>
              ) : null,
            )}
            {level === 0 && <span className="ml-1">— tap a branch to go inside</span>}
          </p>
          <div className="flex shrink-0 items-center gap-1">
            <button type="button" onClick={stepOut} disabled={level === 0} data-testid="map-back"
              className="rounded-full border border-black/[.08] px-2.5 py-1 text-[11px] text-[var(--map-soft)] disabled:opacity-40 dark:border-white/[.145]"
            >Back</button>
            <button type="button" onClick={reset}
              className="rounded-full border border-black/[.08] px-2.5 py-1 text-[11px] text-[var(--map-soft)] dark:border-white/[.145]"
            >Whole business</button>
          </div>
        </div>

        <div className="map-stage relative h-[330px] w-full select-none overflow-hidden bg-[var(--map-surface)] sm:h-[400px] lg:h-[470px]">
          <MapDataStream reducedMotion={reducedMotion} />

          <svg
            viewBox={`0 0 ${G.w} ${G.h}`}
            className="relative h-full w-full"
            role="img"
            aria-label={`${scene.centre.label} at the centre with ${scene.children.length} connected: ${scene.children.map((c) => c.label).join("; ")}`}
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
              transform={`translate(${G.cx} ${G.cy}) scale(${worldScale}) translate(${-G.cx} ${-G.cy})`}
            >
              {/* the level above, as ONE faint mark rather than a whole ring */}
              {scene.parent && (
                <g className="lvl" opacity={0.32} data-testid="map-context">
                  <line x1={G.cx} y1={G.cy} x2={G.cx} y2={G.cy - G.ring * G.ringSquash - G.hub}
                    stroke="var(--map-unknown)" strokeWidth={1} strokeDasharray="3 5" />
                  <text x={G.cx} y={G.cy - G.ring * G.ringSquash - G.hub - 6} textAnchor="middle"
                    fill="var(--map-soft)" fontSize={G.sub}>{scene.parent}</text>
                </g>
              )}

              {scene.children.map((c) => (
                <line key={`e-${c.id}`}
                  x1={G.cx} y1={G.cy} x2={c.x} y2={c.y}
                  stroke={certaintyColor(c.certainty)}
                  strokeWidth={c.certainty === "unknown" ? 1 : 1.6}
                  strokeDasharray={c.certainty === "unknown" ? "4 5" : undefined}
                  opacity={c.certainty === "unknown" ? 0.4 : 0.5}
                />
              ))}

              {/* the centre — always hub-sized, whatever level it is */}
              <circle cx={G.cx} cy={G.cy} r={G.hub * 2.1} fill="url(#mapGlow)" />
              <circle cx={G.cx} cy={G.cy} r={G.hub} fill="var(--map-surface)"
                stroke={certaintyColor(scene.centre.certainty)} strokeWidth={2} />
              <text x={G.cx} y={G.cy + (level === 0 ? G.hub * 0.16 : 2)} textAnchor="middle"
                fill={level === 0 ? "var(--map-inferred)" : "var(--map-ink)"}
                fontSize={level === 0 ? G.hub * 0.44 : G.label * 0.86} fontWeight={600}
                data-testid="map-centre"
              >
                {scene.centre.label.length > 14 ? `${scene.centre.label.slice(0, 13)}…` : scene.centre.label}
              </text>

              {scene.children.map((c) => {
                const right = c.x > G.cx + 1;
                const centred = Math.abs(c.x - G.cx) <= 1;
                const anchor = centred ? "middle" : right ? "start" : "end";
                const dx = centred ? 0 : right ? G.gap : -G.gap;
                const dy = centred ? (c.y > G.cy ? G.label * 1.9 : -G.label * 1.4) : 0;
                return (
                  <g key={c.id} className="hit" role="button" tabIndex={0}
                    data-level="child"
                    aria-label={`${c.label}, ${c.sub}`}
                    onClick={() => go(c.go)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(c.go); }
                    }}
                  >
                    <circle cx={c.x} cy={c.y} r={G.hit} fill="transparent" />
                    <circle cx={c.x} cy={c.y} r={G.dot}
                      fill={c.certainty === "unknown" ? "var(--map-surface)" : certaintyColor(c.certainty)}
                      stroke={certaintyColor(c.certainty)} strokeWidth={1.6} />
                    <text x={c.x + dx} y={c.y + dy - 1} textAnchor={anchor}
                      fill="var(--map-ink)" fontSize={G.label} fontWeight={600}>
                      {c.label.length > 15 ? `${c.label.slice(0, 14)}…` : c.label}
                    </text>
                    <text x={c.x + dx} y={c.y + dy + G.label * 1.05} textAnchor={anchor}
                      fill="var(--map-soft)" fontSize={G.sub}>
                      {c.sub.length > 18 ? `${c.sub.slice(0, 17)}…` : c.sub}
                    </text>
                  </g>
                );
              })}
            </g>
          </svg>

          {card && (
            <div
              data-testid="map-card"
              className="pointer-events-none absolute bottom-2 left-2 z-10 max-w-[62%] rounded-xl border border-black/[.10] bg-[var(--map-surface)]/95 p-2.5 shadow-lg backdrop-blur-sm sm:max-w-[15rem] sm:p-3 dark:border-white/[.14]"
            >
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-semibold leading-tight text-[var(--map-ink)]">{card.title}</p>
                <button type="button" data-testid="map-card-close" onClick={stepOut} aria-label="Close"
                  className="pointer-events-auto -mr-1 -mt-1 shrink-0 rounded px-1 text-sm leading-none text-[var(--map-soft)]"
                >×</button>
              </div>
              <p className="mt-0.5 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-[var(--map-soft)]">
                <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: certaintyColor(card.certainty) }} aria-hidden />
                {card.state}
              </p>
              {card.body && (
                <p className="mt-1.5 line-clamp-2 text-xs leading-snug text-[var(--map-soft)] sm:line-clamp-3">{card.body}</p>
              )}
              {card.destination && (
                <Link href={card.destination.href} data-testid="map-view-link"
                  className="pointer-events-auto mt-2.5 inline-block rounded-full bg-[var(--map-inferred)] px-2.5 py-1 text-[11px] font-medium text-white"
                >{card.destination.label}</Link>
              )}
            </div>
          )}

          {chooserOpen && (
            <ConnectionChooser
              services={services}
              connectionsHref={destinations.connections?.href ?? "#"}
              onClose={() => { setChooserOpen(false); setPath([]); }}
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
            {level === 0
              ? "This is your business data. J4 organises it for you."
              : `${scene.centre.label} — your data, organised by J4.`}
          </span>
        </div>
      </div>
    </section>
  );
}
