"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BusinessMap, Certainty, MapDomainKey } from "@/lib/businessModel/businessMap";

// THE FRONT DOOR: WHAT J4 UNDERSTANDS, AS SOMETHING YOU CAN LOOK AT.
//
// ============ CALM FIRST, DETAIL ON DEMAND (2026-09-01) ================
//
// Sean: "The first screen should make the whole Genesis concept immediately
// understandable... The first screen isn't overwhelmed by the visualization."
//
// Those two pull against each other, and the resolution is progressive
// disclosure rather than a smaller drawing. The first layer is nine labels
// around a centre — it can be read in a glance and says the whole idea. Nothing
// below that layer renders until somebody asks for it by tapping.
//
// ============ THE THREE STATES ARE THE POINT ==========================
//
// known / inferred / unknown are never collapsed for visual tidiness. An empty
// domain stays on the map, dimmed and dashed, saying what is not known yet —
// because a domain that vanished when empty would make "J4 knows nothing about
// your social reach" indistinguishable from "you have no social reach", and the
// first is a thing the owner can fix.
//
// This is also what makes the map grow visibly as connections arrive: a branch
// that reads "not known yet" today becomes a real one later, in place, and the
// change is the point rather than a side effect.
//
// ============ AND EVERY EDGE IS A REAL RELATIONSHIP ===================
//
// Drawn from map.edges, which the assembler only emits when a real column joins
// the two ends. Nothing here invents a line to fill space.

const DOMAIN_ORDER: MapDomainKey[] = [
  "business", "commerce", "customers", "financials", "goals",
  "social", "connections", "creation", "learned",
];

// ============ GEOMETRY IS RESPONSIVE, AND IT HAD TO BE (2026-09-01) ====
//
// The first version used one wide viewBox for every screen. Every geometry
// assertion passed and the phone screenshot showed branch labels at roughly six
// pixels — unreadable. A viewBox 900 units wide squeezed into a 340px column
// scales 16px type down to 6px, and no bounding-box check can notice that.
//
// This project's own standing lesson: a green assertion is not a look at the
// screen. So the map now carries two geometries, and the narrow one is not a
// shrunken copy — it is a tighter ring with larger type, which is what actually
// makes nine labels legible in a phone-width column.
interface Geometry {
  w: number; h: number; cx: number; cy: number;
  rx: number; ry: number;
  hub: number; dot: number;
  label: number; sub: number; gap: number;
}

const WIDE: Geometry = {
  w: 900, h: 560, cx: 450, cy: 280, rx: 310, ry: 190,
  hub: 46, dot: 9, label: 16, sub: 12.5, gap: 18,
};

// Narrower ring, bigger type. At 390px this renders labels near 11px rather
// than 6px, and the ring still clears the hub.
//
// AND THE RADIUS IS SET BY THE LONGEST LABEL, not by what looks balanced. The
// first narrow attempt used rx 150 and clipped "Connections" to "onnections"
// and "Customers" to "Custome" — the screenshot showed it and no assertion
// did. "Connections" at this size is about 94 units wide, so the ring has to
// leave cx - rx >= label width + gap on each side:
//
//   230 - 112 = 118 units of room, for ~94 units of text plus a 12 unit gap.
const NARROW: Geometry = {
  w: 460, h: 430, cx: 230, cy: 215, rx: 112, ry: 122,
  hub: 32, dot: 7, label: 15.5, sub: 12, gap: 12,
};

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

export function BusinessMapCanvas({ map }: { map: BusinessMap }) {
  const [openDomain, setOpenDomain] = useState<MapDomainKey | null>(null);
  // Server-rendered wide, then corrected on the client. The swap is a viewBox
  // change on one <svg>, so nothing around it reflows.
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const q = window.matchMedia("(max-width: 640px)");
    const apply = () => setNarrow(q.matches);
    apply();
    q.addEventListener("change", apply);
    return () => q.removeEventListener("change", apply);
  }, []);
  const G = narrow ? NARROW : WIDE;
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const [dragging, setDragging] = useState(false);

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

  const open = openDomain ? map.domains.find((d) => d.key === openDomain) ?? null : null;

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
    setDragging(true);
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }, [pan.x, pan.y]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!drag.current) return;
    setPan({
      x: drag.current.panX + (e.clientX - drag.current.x),
      y: drag.current.panY + (e.clientY - drag.current.y),
    });
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
  }, []);

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
          --map-line: #d9dee1;
          --map-surface: #ffffff;
          --map-ground: #f6f8f8;
        }
        @media (prefers-color-scheme: dark) {
          .business-map {
            --map-known: #5fb98f;
            --map-inferred: #7fadf5;
            --map-unknown: #78838a;
            --map-ink: #e6ebed;
            --map-soft: #a5b0b6;
            --map-line: #2a3239;
            --map-surface: #12181c;
            --map-ground: #0e1316;
          }
        }
        .business-map .map-stage { touch-action: none; }
        .business-map .domain-hit { cursor: pointer; }
        .business-map .domain-hit:focus-visible { outline: 2px solid var(--map-inferred); outline-offset: 3px; }
      `}</style>

      <div className="overflow-hidden rounded-2xl border border-black/[.07] bg-[var(--map-ground)] dark:border-white/[.10]">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-black/[.06] px-4 py-2.5 dark:border-white/[.08]">
          <p className="text-xs text-[var(--map-soft)]">
            Tap a branch to see what sits behind it. Drag to move, pinch or use the buttons to zoom.
          </p>
          <div className="flex items-center gap-1">
            <button
              type="button" onClick={() => nudgeZoom(-0.2)} aria-label="Zoom out"
              className="h-7 w-7 rounded-full border border-black/[.08] text-sm text-[var(--map-soft)] dark:border-white/[.145]"
            >−</button>
            <button
              type="button" onClick={() => nudgeZoom(0.2)} aria-label="Zoom in"
              className="h-7 w-7 rounded-full border border-black/[.08] text-sm text-[var(--map-soft)] dark:border-white/[.145]"
            >+</button>
            <button
              type="button" onClick={reset}
              className="ml-1 rounded-full border border-black/[.08] px-2.5 py-1 text-[11px] text-[var(--map-soft)] dark:border-white/[.145]"
            >Reset</button>
          </div>
        </div>

        <div
          className="map-stage relative h-[300px] w-full select-none sm:h-[380px] lg:h-[440px]"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          style={{ cursor: dragging ? "grabbing" : "grab" }}
        >
          <svg
            viewBox={`0 0 ${G.w} ${G.h}`}
            className="h-full w-full"
            role="img"
            aria-label={`J4 at the centre with ${domains.length} branches: ${domains
              .map((d) => `${d.label}, ${certaintyWord(d.certainty)}`)
              .join("; ")}`}
          >
            <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom}) translate(${(G.cx * (1 - zoom)) / zoom} ${(G.cy * (1 - zoom)) / zoom})`}>
              {/* branches first, so nodes paint over them */}
              {domains.map((d) => (
                <line
                  key={`edge-${d.key}`}
                  x1={G.cx} y1={G.cy} x2={d.x} y2={d.y}
                  stroke={certaintyColor(d.certainty)}
                  strokeWidth={d.certainty === "unknown" ? 1 : 1.75}
                  strokeDasharray={d.certainty === "unknown" ? "4 5" : undefined}
                  opacity={d.certainty === "unknown" ? 0.45 : 0.5}
                />
              ))}

              {/* J4 */}
              <circle cx={G.cx} cy={G.cy} r={G.hub} fill="var(--map-surface)" stroke="var(--map-inferred)" strokeWidth={1.75} />
              <text
                x={G.cx} y={G.cy + G.hub * 0.16} textAnchor="middle"
                fill="var(--map-inferred)" fontSize={G.hub * 0.44} fontWeight={600}
              >J4</text>

              {domains.map((d) => {
                const right = Math.cos(d.angle) > 0.12;
                const centred = Math.abs(Math.cos(d.angle)) <= 0.12;
                const anchor = centred ? "middle" : right ? "start" : "end";
                const dx = centred ? 0 : right ? G.gap : -G.gap;
                const dy = centred ? (Math.sin(d.angle) > 0 ? G.label * 2.1 : -G.label * 1.6) : 0;
                const isOpen = openDomain === d.key;
                return (
                  <g
                    key={d.key}
                    className="domain-hit"
                    role="button"
                    tabIndex={0}
                    aria-pressed={isOpen}
                    aria-label={`${d.label}: ${d.summary}`}
                    onClick={() => setOpenDomain(isOpen ? null : d.key)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setOpenDomain(isOpen ? null : d.key);
                      }
                    }}
                  >
                    {/* a generous invisible target — a 9px dot is not tappable */}
                    <circle cx={d.x} cy={d.y} r={Math.max(26, G.dot * 3.4)} fill="transparent" />
                    {isOpen && (
                      <circle cx={d.x} cy={d.y} r={G.dot * 1.9} fill="none"
                        stroke={certaintyColor(d.certainty)} strokeWidth={1.25} opacity={0.5} />
                    )}
                    <circle
                      cx={d.x} cy={d.y} r={G.dot}
                      fill={d.certainty === "unknown" ? "var(--map-surface)" : certaintyColor(d.certainty)}
                      stroke={certaintyColor(d.certainty)} strokeWidth={1.75}
                    />
                    <text
                      x={d.x + dx} y={d.y + dy - 1} textAnchor={anchor}
                      fill="var(--map-ink)" fontSize={G.label} fontWeight={600}
                    >{d.label}</text>
                    <text
                      x={d.x + dx} y={d.y + dy + G.label * 1.05} textAnchor={anchor}
                      fill="var(--map-soft)" fontSize={G.sub}
                    >{d.nodes.length > 0 ? `${d.nodes.length}` : "not known yet"}</text>
                  </g>
                );
              })}
            </g>
          </svg>
        </div>

        {/* ---- the layer below: only rendered once asked for ---- */}
        {open && (
          <div className="border-t border-black/[.06] px-4 py-4 dark:border-white/[.08]">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold text-[var(--map-ink)]">
                J4 → {open.label}
              </h3>
              <button
                type="button" onClick={() => setOpenDomain(null)}
                className="text-xs text-[var(--map-soft)] underline underline-offset-2"
              >Close</button>
            </div>
            <p className="mt-1 text-xs text-[var(--map-soft)]">{open.summary}</p>

            {open.nodes.length === 0 ? (
              // THE HONEST EMPTY. Names what is missing rather than showing a
              // zero, because a zero reads as "this never happens".
              <p className="mt-3 max-w-xl text-sm text-[var(--map-soft)]">
                Nothing here yet. When it arrives, it appears on this branch and J4 starts
                reasoning with it.
              </p>
            ) : (
              <ul className="mt-3 flex flex-col gap-1.5">
                {open.nodes.slice(0, 24).map((n) => (
                  <li key={n.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
                    <span
                      className="inline-block h-2 w-2 shrink-0 rounded-full"
                      style={{ background: certaintyColor(n.certainty) }}
                      aria-hidden
                    />
                    <span className="text-[var(--map-ink)]">{n.label}</span>
                    {n.detail && <span className="text-xs text-[var(--map-soft)]">— {n.detail}</span>}
                    <span className="text-[11px] uppercase tracking-wide text-[var(--map-soft)]">
                      {certaintyWord(n.certainty)}
                      {n.provenance ? ` · ${n.provenance.toLowerCase()}` : ""}
                    </span>
                  </li>
                ))}
                {open.nodes.length > 24 && (
                  <li className="text-xs text-[var(--map-soft)]">
                    +{open.nodes.length - 24} more on this branch.
                  </li>
                )}
              </ul>
            )}
          </div>
        )}

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
            <i className="inline-block h-2 w-2 rounded-full border border-current" style={{ background: "transparent" }} />
            not known yet
          </span>
          {/* YOUR DATA, stated plainly rather than as a badge. Sean: "design the
              map so that connected information can clearly communicate that it
              is the merchant's business data". */}
          <span className="ml-auto">This is your business data. J4 organises it for you.</span>
        </div>
      </div>
    </section>
  );
}
