import type { IntegrationProvider } from "@prisma/client";
import type { PlacementId, PrintArea } from "./design";

// WHAT A BLANK ACTUALLY IS, ACROSS SUPPLIERS.
//
// PURE — types and shaping only. The provider-specific fetching lives in each
// connector; what is here is the shape they all have to answer in, so the
// Creation Station is written against one garment model rather than against
// Printful.
//
// ============ EVERY FIELD HERE IS ONE A REAL API RETURNS =================
//
// Checked against Printful's own v2 documentation on 2026-08-27 rather than
// designed and hoped for:
//
//   GET /v2/catalog-products/{id}/catalog-variants
//     → id, size, color, color_code (a hex value), image
//
//   GET /v2/catalog-products/{id}
//     → placements: [{ placement, technique, layers }]
//
//   variant placement_dimensions
//     → [{ placement, width, height }]
//
// So garment colours with real hex swatches, real sizes, a real per-colour
// photograph and real print areas are all provider-backed facts. None of this
// is a palette Genesis invented.
//
// WHAT IS DELIBERATELY ABSENT: weight and box dimensions. Printful and
// Printify were both checked field by field on 2026-08-26 and neither returns
// them — see lib/fulfillment/types.ts's getParcel. A garment model that
// carried them would be carrying nulls forever.

/** One buyable combination — a colour in a size. */
export interface GarmentVariant {
  externalVariantId: string;
  /** As the supplier names it. "Black", "Heather Grey". */
  color: string;
  /** The supplier's own hex. Null where they did not give one. */
  colorHex: string | null;
  size: string;
  /** A photograph of THIS colour, which is what makes a swatch honest. */
  imageUrl: string | null;
  /** The supplier's own cost, in cents. Null when not quoted here. */
  costInCents: number | null;
}

/** A garment, with everything needed to design on it. */
export interface Garment {
  provider: IntegrationProvider;
  externalProductId: string;
  name: string;
  /** "T-Shirt", "Hoodie" — the supplier's own type, used for grouping. */
  type: string | null;
  /**
   * WHO MAKES THE BLANK. Bella + Canvas, Gildan, Champion.
   *
   * Printful puts this in the product title rather than a field of its own, so
   * it is EXTRACTED and may be null. Null means "we could not tell", never
   * "unbranded" — a made-up manufacturer on a real product page is worse than
   * an absent one.
   */
  brand: string | null;
  description: string | null;
  imageUrl: string | null;
  variants: GarmentVariant[];
  /** Only the placements this blank genuinely supports. */
  printAreas: PrintArea[];
}

/** Cents as money, for a screen. Pure, and the one place this is spelled. */
export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * The product's name in the words a person would use for it — pure.
 *
 * ============ THE CATALOGUE TITLE IS NOT A PRODUCT NAME (2026-08-27) ====
 *
 * Sean, on the live screen: "Users should never see that." The screen was
 * showing Printful's own catalogue title —
 *
 *     Unisex Heavy Blend Hoodie | Gildan 18500
 *
 * — which is a SKU line: an audience qualifier, the blank's marketing name,
 * the manufacturer and a model number. Somebody about to make a hoodie is
 * looking at a hoodie.
 *
 * PRESENTATION ONLY. Nothing here changes the catalogue data; garment.name
 * keeps the supplier's exact title, because that is what the supplier calls it
 * and the order, the shelf filter and the manufacturer extraction all depend
 * on it. This is a different sentence for a different reader.
 *
 * The manufacturer is dropped here rather than lost — brandFromTitle already
 * pulls "Gildan" out of the same string, and the screen shows it as its own
 * fact rather than as punctuation in a title.
 */
export function productLabel(name: string): string {
  // Everything before the pipe is the product; after it is the maker and model.
  const beforePipe = name.split("|")[0]?.trim() ?? name.trim();
  // Audience qualifiers describe who a size chart is for, not what the thing
  // is. Removed from the FRONT only, so "Unisex Hoodie" becomes "Hoodie" and a
  // product genuinely called something else keeps its name.
  const withoutAudience = beforePipe.replace(
    /^(unisex|men'?s|women'?s|kids'?|youth|toddler|baby|infant)\s+/i,
    "",
  );
  return withoutAudience.trim() || beforePipe || name;
}

/**
 * The placements a person is offered as views, in the order they think of them.
 *
 * A blank can print in a dozen places — front, back, embroidery_chest_left,
 * sleeve_left, front_dtf — and the screen was listing all of them by their
 * internal names. Front and back are the two views Sean asked to be
 * first-class; the rest stay in printAreas, where validation and the eventual
 * order still read them.
 */
const VIEW_ORDER = ["front", "back"];

export function designableViews(garment: Garment): { placement: string; label: string }[] {
  const has = new Set(garment.printAreas.map((a) => a.placement));
  return VIEW_ORDER.filter((v) => has.has(v)).map((v) => ({
    placement: v,
    label: v === "front" ? "Front" : "Back",
  }));
}

/** The distinct colours of a garment, each with one representative variant. */
export function colorsOf(garment: Garment): { color: string; colorHex: string | null; imageUrl: string | null }[] {
  const seen = new Map<string, { color: string; colorHex: string | null; imageUrl: string | null }>();
  for (const variant of garment.variants) {
    if (seen.has(variant.color)) continue;
    seen.set(variant.color, {
      color: variant.color,
      colorHex: variant.colorHex,
      imageUrl: variant.imageUrl,
    });
  }
  return [...seen.values()];
}

/** The sizes available in a colour — which is not always every size. */
export function sizesFor(garment: Garment, color: string): string[] {
  return [...new Set(garment.variants.filter((v) => v.color === color).map((v) => v.size))];
}

/**
 * The one variant that is this colour in this size.
 *
 * Null rather than a near-miss. A colour sold out in Large is a real state, and
 * quietly substituting Medium would put the wrong thing in a basket.
 */
export function variantFor(garment: Garment, color: string, size: string): GarmentVariant | null {
  return garment.variants.find((v) => v.color === color && v.size === size) ?? null;
}

/** The print area for a placement, or null where the blank has none. */
export function areaFor(garment: Garment, placement: PlacementId): PrintArea | null {
  return garment.printAreas.find((a) => a.placement === placement) ?? null;
}

/** Does this blank print on both sides? Not all of them do. */
export function hasBack(garment: Garment): boolean {
  return garment.printAreas.some((a) => a.placement === "back");
}

/**
 * The manufacturer, from a supplier that does not have a field for it.
 *
 * PURE, AND HONEST ABOUT FAILING. Printful titles read "Unisex Staple T-Shirt |
 * Bella + Canvas 3001" — the brand and the blank's model number after a pipe.
 * When that shape is absent, this returns null rather than guessing from the
 * first word, which would turn "Unisex Staple T-Shirt" into a brand called
 * "Unisex".
 */
export function brandFromTitle(title: string): string | null {
  const afterPipe = title.split("|")[1]?.trim();
  if (!afterPipe) return null;
  // Trailing model numbers belong to the blank, not the maker: "Bella + Canvas
  // 3001" is Bella + Canvas. A name that is ONLY digits is not a brand.
  const withoutModel = afterPipe.replace(/\s+[A-Z]{0,3}\d[\w-]*\s*$/i, "").trim();
  const brand = withoutModel || afterPipe;
  return /[a-z]/i.test(brand) ? brand : null;
}

/**
 * Everything a provider must answer to host the Creation Station.
 *
 * SEPARATE FROM FulfillmentConnector ON PURPOSE. Fulfilment is "make and ship
 * this"; creation is "let somebody design it". A supplier can genuinely do the
 * first and not the second — a wholesale dropshipper has no print areas at all
 * — and folding them together would make every such connector implement
 * methods it must answer null to.
 */
/**
 * A blank as it appears in a supplier's INDEX — enough to recognise and choose
 * between, and nothing more.
 *
 * ============ WHY THIS IS A SEPARATE, CHEAPER SHAPE (2026-08-27) =========
 *
 * A full Garment carries every colour, size and print area, and for Printful
 * that costs two API calls PER BLANK on top of the index. The Creation Station
 * was building full Garments for two dozen blanks in order to show five
 * photographs and, on the shelf, to display two hoodies — 49 calls against a
 * documented 120-per-minute ceiling. Printful said so itself:
 *
 *     Printful creation.catalog failed (429): Rate limit exceeded. You have 0
 *     out of 120 requests remaining.
 *
 * Deciding WHAT to make and choosing WHICH blank both work off the index. Only
 * the designer needs the whole thing. So the index is its own call and its own
 * type, and the expensive one runs on what a person is actually looking at.
 */
export interface Blank {
  externalProductId: string;
  name: string;
  /** The supplier's own type, e.g. "T-SHIRT". Used for matching and grouping. */
  type: string | null;
  /** The supplier's own photograph, where they publish one. */
  imageUrl: string | null;
}

/**
 * A picture of the BLANK — the product with nothing printed on it.
 *
 * ============ WHY THIS IS NOT THE CATALOGUE PHOTOGRAPH (2026-08-27) ======
 *
 * Sean, setting the direction for the design canvas: "I do NOT want the
 * product shown on a person or inside a rectangular/white-background product
 * photo. I want the actual blank product itself isolated on the canvas."
 *
 * The catalogue `image` cannot do that. It is a photograph — frequently a
 * lifestyle shot of somebody wearing the garment — on a white ground, and no
 * background removal rescues it: you cannot cut a model out and be left with a
 * blank hoodie.
 *
 * Printful publishes the thing that can, on its own endpoint, and documents
 * exactly what it is: blank images are "transparent and require the developer
 * to overlay them on top of the color defined on the resource."
 *
 * That is the whole design studio in one sentence. The blank carries the
 * shading, folds, seams and shadows as semi-transparent greys; the COLOUR is
 * painted behind it. So a real Gildan 18500 in any colour Printful actually
 * makes, isolated, with the room showing through around it — from Printful's
 * own imagery rather than a drawing of ours pretending to be their product.
 */
export interface BlankImage {
  /** "front", "back", "left", ... — the supplier's own placement name. */
  placement: string;
  /**
   * The colour this image is FOR, as a hex the variant declares, or null when
   * the image serves every colour.
   *
   * Null is the common case and the useful one: one transparent blank, painted
   * with whichever colour the owner picked.
   */
  colorCode: string | null;
  url: string;
}

export interface CreationProvider {
  provider: IntegrationProvider;
  /**
   * The supplier's index, in ONE call. Cheap enough to run on every page.
   */
  listBlanks(params: { storeId: string }): Promise<Blank[]>;
  /**
   * Full blanks — colours, sizes, print areas. EXPENSIVE: a call or more per
   * blank. Pass only the ids somebody is actually going to be shown.
   */
  getGarments(params: { storeId: string; externalProductIds: string[] }): Promise<Garment[]>;
  /** One blank in full, with every colour, size and print area. */
  getGarment(params: { storeId: string; externalProductId: string }): Promise<Garment | null>;
  /**
   * What the SUPPLIER charges for one of these, in cents, per variant.
   *
   * ============ WHY THIS IS ITS OWN CALL (2026-08-27) =================
   *
   * Sean, on every product showing $75: "That's clearly the test/store selling
   * price, not the supplier price."
   *
   * He was right, and the cause is upstream of the number. Printful's
   * catalog-variants response carries no price field at all — their own
   * reference lists id, catalog_product_id, name, size, color, color_code,
   * image and _links, and nothing else. So costInCents was null for every
   * variant of every product, the designer fell back to a placeholder of
   * 2500 cents, tripled it for a starting margin, and printed $75. The same
   * $75, for everything, forever.
   *
   * The real number lives on /v2/catalog-products/{id}/prices. It is a
   * separate request because it is separate data — and it is the SUPPLIER's
   * price, which is not the selling price and must never be shown as one.
   *
   * An empty map is a real answer: prices vary by selling region and technique,
   * and a product we could not price is better said than guessed.
   */
  getSupplierPrices(params: {
    storeId: string;
    externalProductId: string;
  }): Promise<Record<string, number>>;
  /**
   * Pictures of the blank itself, for the design canvas.
   *
   * SEPARATE FROM getGarment because it is a separate request and only the
   * canvas needs it — a shelf of twelve does not, and paying for twelve of
   * these to render a grid is how the rate limit was hit the first time.
   *
   * An empty array is a real answer: a supplier may publish no blank imagery
   * for a product, and saying so beats substituting a drawing of ours and
   * calling it theirs.
   */
  getBlankImages(params: { storeId: string; externalProductId: string }): Promise<BlankImage[]>;
}
