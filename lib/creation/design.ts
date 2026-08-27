// A PRODUCT BEING DESIGNED, AND WHAT IT MEANS TO MOVE SOMETHING ON IT.
//
// PURE. No provider, no network, no database, no DOM. Every rule about where
// artwork sits, how big it is and whether it is legal lives here, so the same
// arithmetic answers the canvas the owner is dragging on, the print file sent
// to a supplier, and the assertions that prove the two agree.
//
// ============ WHY COORDINATES ARE NORMALISED =============================
//
// A layer's position is stored as a FRACTION OF ITS PRINT AREA (0..1), never in
// pixels or inches.
//
//   pixels  belong to the screen the owner happens to be using
//   inches  belong to one garment in one size from one supplier
//
// Neither survives the thing this has to survive: the same design moved from a
// T-shirt to a hoodie, from Printful to Printify, from a phone to a desktop.
// A logo centred on the chest is centred on the chest at every size, on every
// blank, at every zoom level — and "centred" is 0.5, not 900px.
//
// The conversion to a provider's own units is one pure function
// (toProviderPosition), which is exactly where a supplier's quirks belong.
//
// ============ THE PROVIDER CONTRACT THIS IS SHAPED FOR ===================
//
// Verified against Printful's own documentation on 2026-08-27. A file's
// position is:
//
//   { area_width, area_height, width, height, top, left, limit_to_print_area }
//
// with "(0,0) always located in the top left corner of the print area". That is
// the same origin and the same axes as this model, which is not a coincidence —
// it is why the mapping below is arithmetic rather than interpretation.
//
// Printify accepts a comparable placement model, and the normalisation above is
// what keeps a second provider a mapping function rather than a rewrite.

/**
 * Where on a garment something is printed.
 *
 * Open, not a closed union: Printful alone exposes front, back, sleeve_left,
 * sleeve_right, label_inside, embroidery_chest_left and more, and the set
 * differs per garment and per technique. A closed list here would be a list to
 * maintain against every supplier's catalogue — see garmentPlacements, which
 * reads what a real product actually supports instead.
 */
export type PlacementId = string;

/** The two every apparel blank has, and the only two the first release shows. */
export const FRONT: PlacementId = "front";
export const BACK: PlacementId = "back";

/**
 * One piece of artwork on one placement.
 *
 * x/y is the layer's TOP-LEFT corner as a fraction of the print area, matching
 * the provider's own origin. Storing a centre instead would read more naturally
 * and would need converting at every boundary.
 */
export interface DesignLayer {
  id: string;
  /** A real, publicly reachable image. The supplier fetches this itself. */
  assetUrl: string;
  /** 0..1 across the print area. */
  x: number;
  /** 0..1 down the print area. */
  y: number;
  /** 0..1 of the print area's width. */
  width: number;
  /** 0..1 of the print area's height. */
  height: number;
  /** Mirrored horizontally. Free at print time; it is the same file. */
  flipX: boolean;
  flipY: boolean;
  /** Degrees clockwise. 0 for most designs, and always allowed to be. */
  rotation: number;
}

/** A print area, in the units the supplier states it in. */
export interface PrintArea {
  placement: PlacementId;
  width: number;
  height: number;
  /** "in" or "px" — whatever the supplier said. Never converted, only carried. */
  unit: string;
}

export interface ProductDesign {
  /** The supplier's own product id — a garment, not a variant. */
  externalProductId: string;
  /** The chosen colour/size. Null while the owner is still deciding. */
  externalVariantId: string | null;
  /** Layers per placement. A placement with no layers is simply absent. */
  placements: Record<PlacementId, DesignLayer[]>;
}

export function emptyDesign(externalProductId: string): ProductDesign {
  return { externalProductId, externalVariantId: null, placements: {} };
}

export function layersOn(design: ProductDesign, placement: PlacementId): DesignLayer[] {
  return design.placements[placement] ?? [];
}

/** Every placement that actually has artwork on it. */
export function usedPlacements(design: ProductDesign): PlacementId[] {
  return Object.keys(design.placements).filter((p) => (design.placements[p] ?? []).length > 0);
}

/** Is there anything at all to print? */
export function isEmpty(design: ProductDesign): boolean {
  return usedPlacements(design).length === 0;
}

// ============ CHANGING A DESIGN ==========================================
//
// EVERY ONE OF THESE RETURNS A NEW DESIGN and mutates nothing. Undo is then a
// stack of values rather than a log of inverse operations — and an inverse
// operation that is subtly wrong is a corruption nobody notices until they
// undo twice.

function withLayers(
  design: ProductDesign,
  placement: PlacementId,
  layers: DesignLayer[],
): ProductDesign {
  const next = { ...design, placements: { ...design.placements } };
  if (layers.length === 0) delete next.placements[placement];
  else next.placements[placement] = layers;
  return next;
}

export function addLayer(
  design: ProductDesign,
  placement: PlacementId,
  layer: DesignLayer,
): ProductDesign {
  return withLayers(design, placement, [...layersOn(design, placement), layer]);
}

export function removeLayer(
  design: ProductDesign,
  placement: PlacementId,
  layerId: string,
): ProductDesign {
  return withLayers(design, placement, layersOn(design, placement).filter((l) => l.id !== layerId));
}

export function updateLayer(
  design: ProductDesign,
  placement: PlacementId,
  layerId: string,
  change: (layer: DesignLayer) => DesignLayer,
): ProductDesign {
  return withLayers(
    design,
    placement,
    layersOn(design, placement).map((l) => (l.id === layerId ? change(l) : l)),
  );
}

/**
 * Move a layer BY a delta, keeping it somewhere it can still be grabbed.
 *
 * ============ WHY IT CLAMPS TO A MARGIN, NOT TO THE AREA ================
 *
 * Artwork is allowed to hang off the edge — a wrap-around print is a real
 * design, and Printful's own `limit_to_print_area: false` exists for exactly
 * that. What is NOT allowed is dragging it so far that no part of it is on the
 * garment, because then there is nothing left on screen to drag back and the
 * owner has lost their work with no way to recover it but undo.
 *
 * So a quarter of the layer must remain. Generous enough for a deliberate
 * bleed, strict enough that nothing can be flung into nowhere.
 */
const MIN_VISIBLE = 0.25;

export function moveLayer(
  design: ProductDesign,
  placement: PlacementId,
  layerId: string,
  dx: number,
  dy: number,
): ProductDesign {
  return updateLayer(design, placement, layerId, (layer) => ({
    ...layer,
    x: clamp(layer.x + dx, -layer.width * (1 - MIN_VISIBLE), 1 - layer.width * MIN_VISIBLE),
    y: clamp(layer.y + dy, -layer.height * (1 - MIN_VISIBLE), 1 - layer.height * MIN_VISIBLE),
  }));
}

/**
 * Resize a layer about its centre, preserving aspect ratio.
 *
 * ABOUT THE CENTRE, because that is what a person means by "make it smaller":
 * scaling from the top-left corner slides the artwork up and left as it
 * shrinks, which feels like the tool fighting them.
 *
 * ASPECT PRESERVED, because a logo squashed by a careless drag is a design
 * defect that reaches a customer's chest. Non-uniform scaling is a deliberate
 * feature, not a side effect of a corner handle.
 */
export const MIN_SCALE = 0.02;
export const MAX_SCALE = 4;

export function scaleLayer(
  design: ProductDesign,
  placement: PlacementId,
  layerId: string,
  factor: number,
): ProductDesign {
  return updateLayer(design, placement, layerId, (layer) => {
    const safe = clamp(factor, MIN_SCALE, MAX_SCALE);
    const width = clamp(layer.width * safe, MIN_SCALE, MAX_SCALE);
    const height = clamp(layer.height * safe, MIN_SCALE, MAX_SCALE);
    return {
      ...layer,
      width,
      height,
      x: layer.x + (layer.width - width) / 2,
      y: layer.y + (layer.height - height) / 2,
    };
  });
}

export function flipLayer(
  design: ProductDesign,
  placement: PlacementId,
  layerId: string,
  axis: "x" | "y",
): ProductDesign {
  return updateLayer(design, placement, layerId, (layer) =>
    axis === "x" ? { ...layer, flipX: !layer.flipX } : { ...layer, flipY: !layer.flipY },
  );
}

export function rotateLayer(
  design: ProductDesign,
  placement: PlacementId,
  layerId: string,
  degrees: number,
): ProductDesign {
  return updateLayer(design, placement, layerId, (layer) => ({
    ...layer,
    // Normalised to 0..360 so two full turns is not a different design from
    // none, and so a stored rotation never grows without bound.
    rotation: ((layer.rotation + degrees) % 360 + 360) % 360,
  }));
}

/** Centre a layer horizontally, vertically, or both. */
export function centreLayer(
  design: ProductDesign,
  placement: PlacementId,
  layerId: string,
  axis: "x" | "y" | "both" = "both",
): ProductDesign {
  return updateLayer(design, placement, layerId, (layer) => ({
    ...layer,
    ...(axis !== "y" ? { x: (1 - layer.width) / 2 } : {}),
    ...(axis !== "x" ? { y: (1 - layer.height) / 2 } : {}),
  }));
}

/**
 * A new layer sized to sit sensibly on the garment rather than filling it.
 *
 * Artwork dropped in at full print-area width is almost never what anyone
 * wants and is the first thing they would have to fix. Sixty percent, centred,
 * with the aspect ratio of the image itself — so a wide logo stays wide.
 */
export function layerForAsset(params: {
  id: string;
  assetUrl: string;
  /** The image's own pixel dimensions, for aspect ratio. Square if unknown. */
  naturalWidth?: number;
  naturalHeight?: number;
  /** The print area it is going onto, for aspect correction. */
  area?: PrintArea;
}): DesignLayer {
  const width = 0.6;
  // The image's aspect, corrected for the print area's own aspect — a square
  // logo on a tall print area is not 0.6 x 0.6 of that area, it is narrower.
  const imageAspect =
    params.naturalWidth && params.naturalHeight ? params.naturalWidth / params.naturalHeight : 1;
  const areaAspect = params.area && params.area.height > 0 ? params.area.width / params.area.height : 1;
  const height = clamp((width / imageAspect) * areaAspect, MIN_SCALE, 1);
  return {
    id: params.id,
    assetUrl: params.assetUrl,
    x: (1 - width) / 2,
    y: (1 - height) / 2,
    width,
    height,
    flipX: false,
    flipY: false,
    rotation: 0,
  };
}

// ============ WHAT THE SUPPLIER IS ACTUALLY TOLD =========================

export interface ProviderPosition {
  area_width: number;
  area_height: number;
  width: number;
  height: number;
  top: number;
  left: number;
  limit_to_print_area: boolean;
}

/**
 * A layer, in the supplier's own units.
 *
 * THE WHOLE POINT OF NORMALISATION ARRIVES HERE. Verified against Printful's
 * documentation on 2026-08-27: (0,0) is the top-left of the print area, which
 * is this model's origin too, so every field is a multiplication.
 *
 * `limit_to_print_area` is FALSE deliberately. Printful documents that true
 * returns 400 "Invalid position" the moment artwork crosses the border — and
 * artwork crossing the border is a design somebody chose, not a mistake to
 * reject at the last step. A bleed refused at submission, after the owner has
 * approved the preview, would be the tool disagreeing with the picture it drew.
 *
 * Rounded, because suppliers take integers and a fractional pixel is not a
 * position. Rounded LAST, so the rounding happens once rather than compounding
 * through every drag.
 */
export function toProviderPosition(layer: DesignLayer, area: PrintArea): ProviderPosition {
  return {
    area_width: Math.round(area.width),
    area_height: Math.round(area.height),
    width: Math.round(layer.width * area.width),
    height: Math.round(layer.height * area.height),
    top: Math.round(layer.y * area.height),
    left: Math.round(layer.x * area.width),
    limit_to_print_area: false,
  };
}

/** Every layer of a design, addressed to the areas the supplier gave us. */
export function toProviderPlacements(
  design: ProductDesign,
  areas: PrintArea[],
): { placement: PlacementId; layers: { assetUrl: string; position: ProviderPosition }[] }[] {
  const byPlacement = new Map(areas.map((a) => [a.placement, a]));
  return usedPlacements(design)
    .map((placement) => {
      const area = byPlacement.get(placement);
      // A PLACEMENT THE SUPPLIER DID NOT OFFER IS DROPPED, NOT GUESSED. There
      // is no honest default print area, and inventing one would submit a real
      // print file positioned against a number nobody supplied.
      if (!area) return null;
      return {
        placement,
        layers: layersOn(design, placement).map((layer) => ({
          assetUrl: layer.assetUrl,
          position: toProviderPosition(layer, area),
        })),
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
}

/**
 * Why this design cannot be made yet, or null when it can.
 *
 * ONE FUNCTION, SO THE BUTTON AND THE SERVER AGREE. A disabled button whose
 * reasoning lives in the component is a button that disagrees with the action
 * behind it the first time either changes.
 */
export function designProblem(
  design: ProductDesign,
  areas: PrintArea[],
): string | null {
  if (isEmpty(design)) return "Add some artwork before adding this to your store.";
  if (!design.externalVariantId) return "Choose a colour and size first.";

  const offered = new Set(areas.map((a) => a.placement));
  const unsupported = usedPlacements(design).filter((p) => !offered.has(p));
  if (unsupported.length > 0) {
    // Named, because "something is wrong" is not something anyone can act on.
    return `This blank can't be printed on the ${unsupported.join(" or ")}. Move that artwork or choose a different one.`;
  }
  return null;
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(Math.max(value, min), max);
}
