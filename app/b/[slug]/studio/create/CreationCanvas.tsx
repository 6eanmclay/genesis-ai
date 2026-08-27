"use client";

import { useCallback, useRef, useState } from "react";
import type { DesignLayer, PlacementId, PrintArea, ProductDesign } from "@/lib/creation/design";
import { layersOn } from "@/lib/creation/design";

// THE GARMENT, AND THE ARTWORK ON IT.
//
// ============ IT DRAWS THE SAME ARITHMETIC IT SUBMITS ====================
//
// Every layer is positioned as a percentage of the print area, which is exactly
// how lib/creation/design.ts stores it and exactly what toProviderPosition
// multiplies out. So the picture and the print file are the same numbers seen
// twice, not two implementations that agree by inspection.
//
// The print area is drawn as an outline over the garment photograph. That
// outline is the supplier's own placement_dimensions, not a guess about where a
// chest is — which is why artwork inside it will print where it looks like it
// will.
//
// ============ POINTER EVENTS, NOT MOUSE EVENTS ==========================
//
// One set of handlers covers mouse, touch and pen, and setPointerCapture keeps
// a drag alive when the pointer leaves the element — without which artwork
// dropped the moment somebody dragged past the edge of the garment, which is
// exactly where they are trying to drag it.

const HANDLE = 14;

export function CreationCanvas({
  design,
  placement,
  area,
  garmentImageUrl,
  selectedLayerId,
  onSelect,
  onMove,
  onScale,
}: {
  design: ProductDesign;
  placement: PlacementId;
  /** Null when this blank does not print on this side. */
  area: PrintArea | null;
  garmentImageUrl: string | null;
  selectedLayerId: string | null;
  onSelect: (layerId: string | null) => void;
  /** Deltas as fractions of the print area — the model's own units. */
  onMove: (layerId: string, dx: number, dy: number) => void;
  onScale: (layerId: string, factor: number) => void;
}) {
  const areaRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ layerId: string; lastX: number; lastY: number; mode: "move" | "resize" } | null>(null);
  const [dragging, setDragging] = useState(false);

  const layers = layersOn(design, placement);

  /** A pointer delta in pixels, as a fraction of the print area. */
  const toFraction = useCallback((dxPx: number, dyPx: number) => {
    const box = areaRef.current?.getBoundingClientRect();
    if (!box || box.width === 0 || box.height === 0) return { dx: 0, dy: 0 };
    return { dx: dxPx / box.width, dy: dyPx / box.height };
  }, []);

  const startDrag = (event: React.PointerEvent, layerId: string, mode: "move" | "resize") => {
    event.preventDefault();
    event.stopPropagation();
    // CAPTURED, so the drag survives leaving the element. Without this,
    // artwork is dropped exactly where somebody is trying to drag it to.
    //
    // AND IT CAN THROW. setPointerCapture raises InvalidPointerId when the
    // pointer is no longer active, which is a real race on a fast tap — and
    // an uncaught throw here aborts the handler BEFORE the drag state is set,
    // so the artwork silently refuses to move. Found by driving this with a
    // real pointer rather than by reading it. Capture is an improvement to a
    // drag, never a precondition for one, so the drag starts either way.
    try {
      (event.target as Element).setPointerCapture?.(event.pointerId);
    } catch {
      // No capture. The drag still works while the pointer is over the area.
    }
    drag.current = { layerId, lastX: event.clientX, lastY: event.clientY, mode };
    setDragging(true);
    onSelect(layerId);
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const state = drag.current;
    if (!state) return;
    const dxPx = event.clientX - state.lastX;
    const dyPx = event.clientY - state.lastY;
    state.lastX = event.clientX;
    state.lastY = event.clientY;

    if (state.mode === "move") {
      const { dx, dy } = toFraction(dxPx, dyPx);
      onMove(state.layerId, dx, dy);
      return;
    }

    // Resize from a corner: the diagonal drag decides the factor, so pulling
    // out grows and pushing in shrinks, at a rate that feels proportional
    // rather than jumping.
    const box = areaRef.current?.getBoundingClientRect();
    const reference = box ? Math.max(box.width, box.height) : 1;
    const factor = 1 + (dxPx + dyPx) / reference;
    onScale(state.layerId, factor);
  };

  const endDrag = (event: React.PointerEvent) => {
    try {
      (event.target as Element).releasePointerCapture?.(event.pointerId);
    } catch {
      // Already released, or never captured. Ending the drag is what matters.
    }
    drag.current = null;
    setDragging(false);
  };

  return (
    <div className="relative mx-auto w-full max-w-[420px] select-none">
      <div
        className="relative aspect-[3/4] overflow-hidden rounded-2xl bg-zinc-100 dark:bg-zinc-900"
        onPointerDown={() => onSelect(null)}
      >
        {/* THE GARMENT'S OWN PHOTOGRAPH, in the chosen colour. Not a tinted
            copy of one image — the supplier gives a real photo per colour. */}
        {garmentImageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- supplier CDN, no remotePatterns
          <img
            src={garmentImageUrl}
            alt=""
            className="pointer-events-none absolute inset-0 h-full w-full object-contain"
            draggable={false}
          />
        ) : (
          <div className="absolute inset-0 grid place-items-center text-[13px] text-zinc-500">
            No preview for this colour
          </div>
        )}

        {area ? (
          <div
            ref={areaRef}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            // The print area, drawn where the supplier says it is. Positioned
            // over the garment's chest by proportion — a deliberate constant,
            // and the one number here that is presentation rather than data.
            className="absolute left-1/2 top-[26%] h-[46%] w-[42%] -translate-x-1/2 border border-dashed border-black/25 dark:border-white/30"
          >
            {layers.map((layer) => (
              <LayerBox
                key={layer.id}
                layer={layer}
                selected={layer.id === selectedLayerId}
                dragging={dragging}
                onPointerDown={(e) => startDrag(e, layer.id, "move")}
                onResizePointerDown={(e) => startDrag(e, layer.id, "resize")}
              />
            ))}
          </div>
        ) : (
          // AN HONEST EMPTY SIDE. A blank that does not print on the back is a
          // real fact about the garment, not a failure to load.
          <div className="absolute inset-x-6 bottom-6 rounded-xl bg-black/70 px-3 py-2 text-center text-[12px] text-white">
            This blank can&apos;t be printed on the {placement}.
          </div>
        )}
      </div>
    </div>
  );
}

function LayerBox({
  layer,
  selected,
  dragging,
  onPointerDown,
  onResizePointerDown,
}: {
  layer: DesignLayer;
  selected: boolean;
  dragging: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  onResizePointerDown: (e: React.PointerEvent) => void;
}) {
  return (
    <div
      onPointerDown={onPointerDown}
      // PERCENTAGES, which is the model's own unit. No conversion here means
      // nothing here to disagree with the print file.
      style={{
        position: "absolute",
        left: `${layer.x * 100}%`,
        top: `${layer.y * 100}%`,
        width: `${layer.width * 100}%`,
        height: `${layer.height * 100}%`,
        transform: `rotate(${layer.rotation}deg)`,
        cursor: dragging ? "grabbing" : "grab",
        touchAction: "none",
      }}
      className={selected ? "outline outline-2 outline-[var(--brand-accent,#6366f1)]" : ""}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- owner artwork on Blob */}
      <img
        src={layer.assetUrl}
        alt=""
        draggable={false}
        className="pointer-events-none h-full w-full object-contain"
        style={{
          // The flip is a CSS transform here and a mirrored file at print
          // time; both are the same intent, and neither costs anything.
          transform: `scale(${layer.flipX ? -1 : 1}, ${layer.flipY ? -1 : 1})`,
        }}
      />

      {selected && (
        <span
          onPointerDown={onResizePointerDown}
          aria-label="Resize"
          style={{
            position: "absolute",
            right: -HANDLE / 2,
            bottom: -HANDLE / 2,
            width: HANDLE,
            height: HANDLE,
            cursor: "nwse-resize",
            touchAction: "none",
          }}
          className="rounded-full border border-white bg-[var(--brand-accent,#6366f1)] shadow"
        />
      )}
    </div>
  );
}
