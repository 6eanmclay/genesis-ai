import type { Design, PlacementDesign } from "@/lib/businessModel/entities";
import type { ProductDesign, PrintArea } from "@/lib/creation/design";
import type { Garment } from "@/lib/creation/garment";

// A SAVED DESIGN, BOTH WAYS — pure, so both directions are testable.
//
// ============ WHY SAVE DID NOT PRODUCE ANYTHING REOPENABLE ==============
//
// Sean, after testing the live deployment: "If someone saves a design because
// they're not sure it's finished, it should remain available in their Creation
// Station/design library so they can reopen it later and continue working."
//
// It could not, and the trace says exactly why. "Save this design" called
// addDesignToStore, which wrote a PRODUCT row carrying a `designSpec` blob —
// and `designSpec` HAS NO READERS ANYWHERE IN THE CODEBASE. Nothing lists it,
// nothing loads it, no route reopens it. The design was written into a field
// that only ever gets written. Saving was real; recovering was never built.
//
// So a save now writes a `design` record — the entity that already exists and
// that productFromDesign.ts already consumes — and these two functions are the
// round trip. `toDraft` is what Save stores; `toDesign` is what reopening
// restores. A suite runs a design through both and asserts it comes back
// unchanged, which is the property that makes "come back later" true.
//
// ============ WHAT IS DELIBERATELY NOT HERE ============================
//
// No Growth Points, no product, no supplier. Saving is free and repeatable —
// Sean: "The user should be able to save something 10 times while working on it
// without paying Growth Points every time." Nothing in this file can charge for
// anything, which is the cheapest way to keep that true.

/** What a save needs to know beyond the design itself. */
export interface DraftContext {
  garment: Garment;
  /** What the owner called it. */
  name: string;
  /** What they intend to sell it for. Null while they have not said. */
  retailPriceInCents: number | null;
}

/**
 * The record data for a saved design.
 *
 * The garment's own facts — colour and size by NAME, the print areas — are
 * frozen onto the draft rather than looked up again on reopening. A supplier
 * catalogue moves; a draft the owner left half-finished should come back as
 * they left it, and a variant that has since disappeared should be visible as
 * a problem rather than silently resolving to a different one.
 */
export function toDraft(design: ProductDesign, context: DraftContext, previous?: PlacementDesign | null): Design {
  const { garment, name, retailPriceInCents } = context;
  const variant = garment.variants.find((v) => v.externalVariantId === design.externalVariantId) ?? null;

  return {
    // A product design, so the composition half is empty. See DesignSchema.
    assetIds: [],
    surface: "",
    arrangement: "",
    arrangementScale: null,
    printFileUrl: null,
    mockupUrl: null,
    sourceAssetUrls: layerUrls(design),
    createdAt: previous?.updatedAt ?? new Date().toISOString(),
    placement: {
      provider: garment.provider,
      externalProductId: design.externalProductId,
      externalVariantId: design.externalVariantId,
      productName: name || garment.name,
      color: variant?.color ?? null,
      size: variant?.size ?? null,
      placements: design.placements,
      printAreas: garment.printAreas,
      retailPriceInCents,
      // CARRIED FORWARD, NEVER RESET. Re-saving a draft that has already been
      // created must not make it look uncreated — that would offer the owner a
      // second 2-point Create for a product they already have.
      productId: previous?.productId ?? null,
      supplierProductCreated: previous?.supplierProductCreated ?? false,
      updatedAt: new Date().toISOString(),
    },
  };
}

/**
 * The design an owner left behind, ready to go back into the editor.
 *
 * Null for a composed design, because there is nothing here for the placement
 * editor to open — the two shapes share a record type and not a meaning.
 */
export function toDesign(data: Design): ProductDesign | null {
  const p = data.placement;
  if (!p) return null;
  return {
    externalProductId: p.externalProductId,
    externalVariantId: p.externalVariantId,
    placements: p.placements,
  };
}

/** Is this record a product design rather than a composition? */
export function isPlacementDraft(data: Design): boolean {
  return data.placement !== null;
}

/** Has this draft already become a product? */
export function isCreated(data: Design): boolean {
  return data.placement?.productId !== null && data.placement?.productId !== undefined;
}

/** Every distinct piece of artwork used, in first-seen order. */
export function layerUrls(design: ProductDesign): string[] {
  const seen: string[] = [];
  for (const layers of Object.values(design.placements)) {
    for (const layer of layers) if (!seen.includes(layer.assetUrl)) seen.push(layer.assetUrl);
  }
  return seen;
}

/** The print areas a draft was saved against, as the design layer wants them. */
export function draftPrintAreas(data: Design): PrintArea[] {
  return (data.placement?.printAreas ?? []) as PrintArea[];
}

/** A one-line description for a list of saved designs. */
export function draftSummary(data: Design): string {
  const p = data.placement;
  if (!p) return "A composition";
  const sides = Object.entries(p.placements)
    .filter(([, layers]) => layers.length > 0)
    .map(([placement]) => placement);
  const where = sides.length === 0 ? "nothing on it yet" : sides.join(" and ");
  const colour = p.color ? `${p.color}, ` : "";
  return `${colour}${where}`;
}
