"use client";

import { useCallback, useRef, useState } from "react";
import { PRINT_AREA_BOX } from "@/lib/creation/mockupGeometry";
import type { DesignLayer, PlacementId, PrintArea, ProductDesign } from "@/lib/creation/design";
import { layersOn } from "@/lib/creation/design";
import { BlankOnColor } from "./BlankOnColor";

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
  blankUrl,
  colorHex,
  creatableId,
  turning,
  safeMargin,
  selectedLayerId,
  onSelect,
  onRemoveLayer,
  onMove,
  onScale,
}: {
  design: ProductDesign;
  placement: PlacementId;
  /** Null when this blank does not print on this side. */
  area: PrintArea | null;
  /** The supplier's transparent blank for the placement on screen. */
  blankUrl: string | null;
  /** The hex the supplier declares for the chosen colour. */
  colorHex: string | null;
  /** Only used when the supplier has no blank — see BlankOnColor. */
  creatableId: string;
  /** True for the moment the garment is being turned to another view. */
  turning: boolean;
  /** Fraction of the print area kept clear at its edges. See padPanel. */
  safeMargin: number;
  selectedLayerId: string | null;
  onSelect: (layerId: string | null) => void;
  /** Take this artwork off the design. Never touches the uploaded asset. */
  onRemoveLayer: (layerId: string) => void;
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
        // NO CARD BEHIND THE PRODUCT. The blank is transparent, so the
        // Creation Station's own background belongs behind it — a filled
        // rounded rectangle here is the white square by another name.
        //
        // THE TURN. Spin swaps to the next view the supplier photographed, and
        // this is the half-second that makes it read as the garment turning
        // rather than the picture being replaced. Presentation only: the view
        // has already changed underneath.
        className="relative aspect-[3/4] overflow-hidden rounded-2xl transition-transform duration-300"
        style={{
          transformStyle: "preserve-3d",
          transform: turning ? "rotateY(28deg) scale(0.96)" : "rotateY(0deg) scale(1)",
        }}
        onPointerDown={() => onSelect(null)}
      >
        {/* ============ THE BLANK, IN THE COLOUR THEY MAKE IT ===========
            Colour behind, the supplier's transparent blank on top, artwork
            above that. Printful's own instruction for this imagery: overlay
            it "on top of the color defined on the resource".

            This used to be the catalogue photograph for the chosen colour,
            which is a picture of a product rather than a product being made —
            and for many blanks it is a lifestyle shot with a person in it. */}
        <BlankOnColor
          blankUrl={blankUrl}
          colorHex={colorHex}
          creatableId={creatableId}
          className="pointer-events-none absolute inset-0 h-full w-full"
        />

        {area ? (
          <div
            ref={areaRef}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            // The print area, drawn where the supplier says it is. Positioned
            // over the garment's chest by proportion — a deliberate constant,
            // and the one number here that is presentation rather than data.
            //
            // IMPORTED, NOT WRITTEN TWICE (2026-08-28). The server composes the
            // product's mockup into this same rectangle, and a constant that
            // decides where artwork sits would, written down in two places,
            // become a preview and a product photograph that disagree the first
            // time either is adjusted. See lib/creation/composeMockup.ts.
            className="absolute border border-dashed border-black/25 dark:border-white/30"
            style={{
              left: `${PRINT_AREA_BOX.x * 100}%`,
              top: `${PRINT_AREA_BOX.y * 100}%`,
              width: `${PRINT_AREA_BOX.width * 100}%`,
              height: `${PRINT_AREA_BOX.height * 100}%`,
            }}
          >
            {/* THE SAFE MARGIN, WHERE THERE IS ONE. A second, tighter guide
                inside the supplier's printable rectangle: printers cut and
                press with tolerance, and artwork flush to the edge is the
                artwork that comes back trimmed. Drawn rather than enforced —
                a guide the owner can cross deliberately is more useful than a
                wall they cannot, and the print area itself is still the hard
                limit the design model checks against. */}
            {safeMargin > 0 && (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute border border-dashed border-black/15 dark:border-white/20"
                style={{
                  inset: `${safeMargin * 100}%`,
                }}
              />
            )}

            {layers.map((layer) => (
              <LayerBox
                key={layer.id}
                layer={layer}
                selected={layer.id === selectedLayerId}
                dragging={dragging}
                onPointerDown={(e) => startDrag(e, layer.id, "move")}
                onRemove={() => onRemoveLayer(layer.id)}
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
  onRemove,
}: {
  layer: DesignLayer;
  selected: boolean;
  dragging: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  onResizePointerDown: (e: React.PointerEvent) => void;
  onRemove: () => void;
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

      {/* ============ TAKING IT OFF THE GARMENT (2026-08-28) ============
          Sean: "Once an image is actually placed on the garment, there needs to
          be an obvious × / Remove control for that layer so users don't have to
          leave Creation Station and come back just to get rid of something."

          There was a Remove, and it was three taps away: select the layer, open
          Edit, find it in a row of six. On the layer itself it is one.

          THIS IS NOT THE OTHER ✕. This takes artwork off the design; the one in
          the Add panel deletes an upload from the library. Different actions,
          deliberately different places — and this one destroys nothing, since
          the asset stays exactly where it was.

          onPointerDown stops the drag handler underneath from claiming the
          gesture: without it, a tap here starts moving the layer and the click
          never arrives. */}
      {selected && (
        <button
          type="button"
          aria-label="Remove this artwork"
          title="Remove this artwork"
          onPointerDown={(event) => {
            event.stopPropagation();
            event.preventDefault();
          }}
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
          style={{
            position: "absolute",
            left: -22,
            top: -22,
            width: 44,
            height: 44,
            touchAction: "none",
          }}
          className="grid place-items-center"
        >
          <span className="grid h-6 w-6 place-items-center rounded-full bg-zinc-900/90 text-[12px] text-white shadow dark:bg-white/90 dark:text-black">
            ✕
          </span>
        </button>
      )}
    </div>
  );
}
