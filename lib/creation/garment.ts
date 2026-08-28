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

/**
 * The views a garment can actually be turned to, in the order it turns.
 *
 * ============ SPIN IS LIMITED BY WHAT THE SUPPLIER PHOTOGRAPHED ========
 *
 * Sean wants the product itself rotatable — "Front → 3/4 → Back → 3/4 →
 * Front", becoming a 360 viewer "if the available supplier imagery supports
 * it". That last clause is the whole constraint, and it is worth being precise
 * about rather than discovering later.
 *
 * A blank has as many views as Printful publishes pictures for. Today that is
 * front and back for a hoodie. There is no three-quarter image, so there is no
 * three-quarter view — inventing one would mean rendering a garment from an
 * angle the manufacturer never photographed, which is the same rule that says
 * we do not draw their product for them.
 *
 * So this returns the REAL views, and the number of them is what the interface
 * should say. Two today; more the moment a supplier publishes more, with no
 * change here.
 */
export function spinViews(garment: Garment, blankImages: BlankImage[]): string[] {
  // A view needs a picture. Placements with a print area but no blank image
  // are printable, not viewable, and Spin is about looking at the product.
  const withImages = new Set(blankImages.map((b) => b.placement));
  const ordered = designableViews(garment)
    .map((v) => v.placement)
    .filter((p) => withImages.has(p));

  // Any other angle the supplier published, after the two named ones — a
  // "left" or "lifestyle" placement is a real view even though it is not a
  // design surface, and Spin is the one control that wants it.
  const extras = [...withImages].filter((p) => !ordered.includes(p)).sort();
  return [...ordered, ...extras];
}

/**
 * Two colour codes that mean the same colour — pure.
 *
 * ============ WHY THIS IS NOT `a === b` (2026-08-27) ==================
 *
 * The blank on the canvas never changed with the colour, and this is half the
 * reason: Printful writes a variant's colour as "#0A0A0A" in one place and its
 * blank image's colour as "0a0a0a" in another. Compared as strings those are
 * different colours, so the per-colour blank was never found, the code fell
 * back to whatever image came first, and the garment stayed that colour
 * whatever was selected.
 */
export function sameColor(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const norm = (v: string) => v.trim().toLowerCase().replace(/^#/, "");
  const left = norm(a);
  const right = norm(b);
  if (left === right) return true;
  // #fff and #ffffff are the same colour written two ways.
  const expand = (v: string) => (v.length === 3 ? v.split("").map((c) => c + c).join("") : v);
  return expand(left) === expand(right);
}

/**
 * The blank to show for a placement and a colour, and whether it needs tinting.
 *
 * ============ TWO KINDS OF BLANK, AND ONLY ONE NEEDS COLOURING ========
 *
 * Printful publishes per-colour blanks for some products and one colour-neutral
 * blank for others. They are not interchangeable:
 *
 *   - a blank FOR this colour is already the product in that colour, with the
 *     manufacturer's own lighting. Painting anything behind it is wrong.
 *   - a colour-neutral blank is the one their documentation means by "overlay
 *     on top of the color defined on the resource".
 *
 * The old code always tinted, and always used the first image when the colour
 * match failed — which is how a black hoodie stayed black while the room
 * changed colour behind it.
 */
/**
 * Why there is no blank to show — which is never just "no image".
 *
 * Sean: "I don't want a missing garment simply dismissed as 'no image' until
 * we've confirmed that Printful actually gave us no usable blank for that
 * variant."
 *
 * Three different absences, and they call for three different sentences:
 *
 *   none          the supplier published nothing at all for this product
 *   other-colours they published blanks, but none for the colour chosen and
 *                 no colour-neutral one to paint
 *   other-views   they published blanks for other placements only
 */
export type BlankAbsence = "none" | "other-colours" | "other-views" | null;

export function blankFor(
  images: BlankImage[],
  placement: string,
  colorHex: string | null,
  /** The supplier's name for the chosen colour, which is how they label blanks. */
  colorName?: string | null,
): { url: string | null; tintWith: string | null; absence: BlankAbsence } {
  if (images.length === 0) return { url: null, tintWith: null, absence: "none" };

  const forPlacement = images.filter((b) => b.placement === placement);
  // FALLING BACK TO ANOTHER VIEW IS A DECISION, not a default. A front image
  // shown on the back tab is the wrong picture presented confidently, so the
  // pool stays empty and the absence is named instead.
  if (forPlacement.length === 0) return { url: null, tintWith: null, absence: "other-views" };

  // ============ ONE BASE FILE, RENDERED PER COLOUR (2026-08-27) ========
  //
  // The trace settled what these images are. Printful publishes ONE garment
  // file per placement — Ash and Carolina Blue both point at
  // 05_gildan18500_flat_front_base_whitebg.png — and it is not a photograph:
  // the background is opaque white and the garment is a ~10% opaque shading
  // layer. The colour is meant to be composed underneath it, and each image
  // record carries the colour it is for in `background_color`.
  //
  // So "find the blank for this colour" is really "find the record for this
  // colour, and render its base file in that colour". `tintWith` is now the
  // colour to RENDER WITH, not a wash to lay over a finished picture — see
  // /api/creation/blank, which does the composition server-side.
  const exact = forPlacement.find(
    (b) =>
      sameColor(b.colorCode, colorHex) ||
      (b.colorName != null &&
        colorName != null &&
        b.colorName.trim().toLowerCase() === colorName.trim().toLowerCase()),
  );
  if (exact) {
    // The colour on the record beats the one passed in: it is the supplier's
    // own value for this exact render.
    return { url: exact.url, tintWith: exact.colorCode ?? colorHex, absence: null };
  }

  // NEUTRAL MEANS UNLABELLED — no code AND no name. An image labelled "Black"
  // is not a blank canvas for gold.
  const neutral = forPlacement.find((b) => b.colorCode === null && b.colorName === null);
  if (neutral) return { url: neutral.url, tintWith: colorHex, absence: null };

  // ONLY BLANKS FOR OTHER COLOURS. Showing one and tinting it would put a
  // second colour over a garment that already has one — a navy hoodie under a
  // gold wash. Better to show nothing than to show the wrong product, and
  // better still to say WHICH nothing this is.
  return { url: null, tintWith: null, absence: "other-colours" };
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
/**
 * The colours this garment can actually be SHOWN in.
 *
 * ============ OFFER WHAT CAN BE RENDERED (2026-08-27) =================
 *
 * Sean: "Only show colors that we can actually render correctly... I'd rather
 * have 8-10 colors that look perfect than 14 colors where some don't work or
 * load slowly."
 *
 * This inverts the problem rather than solving it. Every previous attempt has
 * been about what to DO when a colour has no blank of its own — tint a neutral
 * one, tint somebody else's, show an outline and explain. All of those put a
 * wrong or apologetic garment on screen. Not offering the colour puts nothing
 * wrong on screen at all.
 *
 * A colour is offered when the supplier publishes a blank for it on the view
 * being designed. That is the only test, and it is the same function the
 * canvas uses to pick the image — so a colour that appears in the row is one
 * that has already been proven to resolve.
 *
 * ============ AND IF THAT LEAVES NOTHING ==============================
 *
 * An empty row is a real answer and a loud one. It means the supplier
 * published images this code could not attribute to any colour, which is worth
 * seeing immediately rather than discovering as a garment that will not change.
 */
export function renderableColors(
  garment: Garment,
  blankImages: BlankImage[],
  placement: string,
): { color: string; colorHex: string | null; imageUrl: string | null }[] {
  const all = colorsOf(garment);
  // NO BLANKS AT ALL is not the same as none matching. With no supplier
  // imagery the editor falls back to the drawn outline for every colour, and
  // every colour is equally showable — removing them all would leave nothing
  // to choose from for a reason the owner cannot act on.
  if (blankImages.length === 0) return all;

  // ============ ITS OWN BLANK, OR IT IS NOT OFFERED ==================
  //
  // A colour counts only when the supplier publishes a blank FOR IT — an exact
  // match, needing no tint. A colour that resolves by painting a neutral blank
  // does not count, and that is the whole lesson of the black hoodie with blue
  // drawstrings: the "neutral" blank was a black hoodie whose colour this code
  // had failed to read, and multiply cannot lighten black.
  //
  // THE TRADE-OFF, STATED. A supplier who genuinely publishes ONE colour-
  // neutral blank meant for tinting would be left with no colours here, and
  // the row would say so. That is the wrong answer for that supplier and the
  // right one for the only supplier we have — Printful's blanks are per
  // colour, and treating them as neutral is what produced the bug. When a
  // supplier who works the other way turns up, this is the line to revisit,
  // and the empty row is what will point at it.
  // A COLOUR IS OFFERED WHEN WE HAVE BOTH HALVES: the supplier's base file for
  // this view, and a colour to render it in. That is the whole test now.
  //
  // REVISED FROM "no tint allowed" (2026-08-27). That rule was right when a
  // tint meant washing a finished photograph — the black hoodie with blue
  // drawstrings. It is wrong now that the trace has shown these files ARE
  // shading layers with no colour of their own: rendering is not a fallback
  // here, it is how Printful intends the garment to be produced.
  return all.filter((c) => {
    const resolved = blankFor(blankImages, placement, c.colorHex, c.color);
    return resolved.url !== null && (resolved.tintWith ?? c.colorHex) !== null;
  });
}

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
   * The colour this image is FOR, as a hex, or null.
   *
   * ============ NULL IS NOT "SERVES EVERY COLOUR" (2026-08-27) ========
   *
   * It used to be documented as exactly that, and the assumption cost two
   * rounds. Printful labels its blanks by colour NAME — "Black", "Gold" — and
   * the parser only accepted a hex, so every image came back with a null code,
   * every image therefore looked colour-neutral, and the first one got painted
   * for all fourteen colours. The first one is the black hoodie, and multiply
   * cannot lighten black: gold over it produced a gold background and a brown
   * garment.
   *
   * So a blank is colour-neutral only when it carries NEITHER a code nor a
   * name. Both are kept, and either can identify it.
   */
  colorCode: string | null;
  /** The supplier's own name for that colour, e.g. "Gold". */
  colorName: string | null;
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
