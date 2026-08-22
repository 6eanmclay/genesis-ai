// What a design is made ON (2026-08-16).
//
// Surface is a FIRST-CLASS INPUT, which is the constraint WORK_STUDIO.md
// records and the reason this file exists before any composition code. A
// design layer built only for print would model a design as "artwork for a
// garment", and storefront composition would then arrive as a second,
// competing system. They are one capability:
//
//   Design = asset(s) + surface + arrangement
//
// A T-shirt is a surface whose arrangement is a placement. A storefront
// section is a surface whose arrangement is a composition. Same shape.
//
// A CLOSED REGISTRY, matching the discipline refine_storefront already uses
// for its targets: a caller picks a key from here, never a free string that
// reaches a renderer. Adding a surface is an entry here, nothing else.

// "product" is anything physical the artwork is placed ON and that a customer
// could buy — apparel, headwear, drinkware, accessories, print. "section" is a
// storefront composition, which IS its own output. createDesign branches on
// this and nothing else, so a new product category needs no new code path.
export type SurfaceKind = "product" | "section";

// How the catalogue is grouped for the owner. Adding a category is an entry
// here plus surfaces that reference it — never a new system.
export const SURFACE_CATEGORIES: { key: string; label: string }[] = [
  { key: "apparel", label: "Apparel" },
  { key: "headwear", label: "Headwear" },
  { key: "drinkware", label: "Drinkware" },
  { key: "accessories", label: "Accessories" },
  { key: "print", label: "Home and print" },
];

export interface Surface {
  key: string;
  label: string;
  kind: SurfaceKind;
  /** A key from SURFACE_CATEGORIES. Absent for section surfaces. */
  category?: string;
  /** The real output canvas, in pixels. For print, this is the print area. */
  output: { width: number; height: number };
  /**
   * Where artwork sits on the mockup, as fractions of the mockup's own size.
   * Fractions rather than pixels so one definition survives a mockup base
   * being re-rendered at a different resolution.
   */
  /**
   * Where artwork sits on the mockup. GARMENT SURFACES ONLY — a section
   * surface has no base to sit on, because the composition IS the output.
   */
  mockupArea?: { x: number; y: number; width: number; height: number };
  /**
   * How to render a blank base when one is not cached yet. Garment only, for
   * the same reason: there is no blank storefront section to photograph.
   *
   * Renders a NEUTRAL light grey product. Colour is applied afterwards, as a
   * deterministic image operation rather than a word in this prompt — see
   * recolorProduct in createDesign.ts for why. Asking a model for "black" and
   * hoping is what produced grey hoodies described as black.
   */
  basePrompt?: string;
  /**
   * Background behind a section composition. Sections need one because the
   * artwork does not fill the canvas; garments do not, because the garment
   * photograph is the background.
   */
  background?: { r: number; g: number; b: number };
  /** Gap between cells in a section composition, as a fraction of cell size. */
  gutter?: number;
}

// THE PRODUCT CATALOGUE (2026-08-18).
//
// Sean: "do not treat Products as a small hardcoded list of suggestions... the
// same asset should be reusable across all of these surfaces." So this is a
// registry, and every entry is the same four facts: what the print area is,
// where the artwork sits on the mockup, how to render a blank one, and which
// category it belongs to. Adding a surface is an entry here and nothing else —
// no new pipeline, no new tool, no new approval path. createDesign, the tool
// schema and the Studio UI all read from this.
//
// The print areas are real. Where a provider publishes a standard (DTG 12x16in
// at 150dpi for apparel), that is what is used; where one does not, the
// dimensions are the sensible print size for the item rather than a decorative
// number. mockupArea placements are considered estimates — the owner sees the
// composed result before anything is approved, which is what makes an estimate
// safe here and would not make it safe in a print file.
//
// {color} is substituted at generation time. Colour is a real input; see
// GARMENT_COLORS and createDesign's own verification of the rendered result.
function apparel(key: string, label: string, item: string, area: Surface["mockupArea"]): Surface {
  return {
    key,
    label,
    kind: "product",
    category: "apparel",
    // 12in x 16in at 150dpi — the standard DTG print area.
    output: { width: 1800, height: 2400 },
    mockupArea: area,
    basePrompt: `A plain light grey ${item} laid flat on a pure white background, front view, centered, evenly lit with soft natural shadows and visible fabric texture and seams, no graphics, no text, no logo, product photography.`,
  };
}

function accessory(
  key: string,
  label: string,
  category: string,
  item: string,
  output: { width: number; height: number },
  area: Surface["mockupArea"]
): Surface {
  return {
    key,
    label,
    kind: "product",
    category,
    output,
    mockupArea: area,
    basePrompt: `A plain light grey ${item} on a pure white background, centered, evenly lit with soft natural shadows and visible surface texture, no graphics, no text, no logo, product photography.`,
  };
}

export const SURFACES: Record<string, Surface> = {
  // Apparel
  "garment.tshirt": apparel("garment.tshirt", "T-shirt", "t-shirt", { x: 0.31, y: 0.26, width: 0.38, height: 0.34 }),
  "garment.hoodie": apparel("garment.hoodie", "Hoodie", "pullover hoodie", { x: 0.33, y: 0.32, width: 0.34, height: 0.3 }),
  "garment.sweatshirt": apparel("garment.sweatshirt", "Sweatshirt", "crewneck sweatshirt", { x: 0.32, y: 0.29, width: 0.36, height: 0.32 }),
  "garment.tank": apparel("garment.tank", "Tank top", "tank top", { x: 0.34, y: 0.25, width: 0.32, height: 0.34 }),
  "garment.jacket": apparel("garment.jacket", "Jacket", "zip-up jacket", { x: 0.34, y: 0.3, width: 0.32, height: 0.28 }),

  // Headwear — small print areas, because embroidery panels are small.
  "headwear.cap": accessory("headwear.cap", "Cap", "headwear", "baseball cap", { width: 1200, height: 600 }, { x: 0.36, y: 0.4, width: 0.28, height: 0.2 }),
  "headwear.beanie": accessory("headwear.beanie", "Beanie", "headwear", "knit beanie", { width: 1200, height: 600 }, { x: 0.37, y: 0.52, width: 0.26, height: 0.16 }),
  "headwear.bucket": accessory("headwear.bucket", "Bucket hat", "headwear", "bucket hat", { width: 1200, height: 600 }, { x: 0.38, y: 0.46, width: 0.24, height: 0.16 }),

  // Drinkware — wrap areas, so the artwork sits on the visible face.
  "drinkware.mug": accessory("drinkware.mug", "Mug", "drinkware", "ceramic mug with the handle to the right", { width: 2250, height: 1125 }, { x: 0.34, y: 0.34, width: 0.3, height: 0.32 }),
  "drinkware.tumbler": accessory("drinkware.tumbler", "Tumbler", "drinkware", "insulated tumbler", { width: 2000, height: 1400 }, { x: 0.38, y: 0.3, width: 0.24, height: 0.36 }),
  "drinkware.bottle": accessory("drinkware.bottle", "Water bottle", "drinkware", "stainless steel water bottle", { width: 1800, height: 1400 }, { x: 0.4, y: 0.28, width: 0.2, height: 0.38 }),

  // Accessories
  "accessory.tote": accessory("accessory.tote", "Tote bag", "accessories", "canvas tote bag", { width: 1800, height: 1800 }, { x: 0.3, y: 0.3, width: 0.4, height: 0.36 }),
  "accessory.phonecase": accessory("accessory.phonecase", "Phone case", "accessories", "phone case, back view", { width: 1200, height: 2400 }, { x: 0.3, y: 0.28, width: 0.4, height: 0.4 }),

  // Home and print — the artwork is most of the product, so the areas are large.
  "print.poster": accessory("print.poster", "Poster", "print", "blank framed poster on a wall", { width: 2400, height: 3200 }, { x: 0.22, y: 0.2, width: 0.56, height: 0.6 }),
  "print.sticker": accessory("print.sticker", "Sticker", "print", "blank die-cut sticker", { width: 1500, height: 1500 }, { x: 0.2, y: 0.2, width: 0.6, height: 0.6 }),
};

/** Every product surface, grouped for the owner. */
export function surfacesByCategory(): { key: string; label: string; surfaces: Surface[] }[] {
  return SURFACE_CATEGORIES.map((c) => ({
    ...c,
    surfaces: Object.values(SURFACES).filter((sf) => sf.category === c.key),
  })).filter((c) => c.surfaces.length > 0);
}

/** Keys the conversation is allowed to name. Derived, never hand-maintained. */
export function productSurfaceKeys(): string[] {
  return Object.values(SURFACES)
    .filter((sf) => sf.kind === "product")
    .map((sf) => sf.key);
}

// STOREFRONT SURFACES (2026-08-18). The other half of the surface idea, and
// the reason `surface` was made a first-class input before any of this existed:
// a T-shirt is a surface whose arrangement is a placement, a storefront section
// is a surface whose arrangement is a COMPOSITION. Same Design model, same
// compositor, different canvas — never a second creative system.
//
// These are also the first surfaces whose output is not something a customer
// buys. Sean: "J4 needs to understand the difference between 'this is something
// the customer can buy' and 'this is something that makes the store look better
// and tells the brand story.'" A section design becomes a storefront ASSET, not
// a Product.
export const SECTION_SURFACES: Record<string, Surface> = {
  "section.hero": {
    key: "section.hero",
    label: "Storefront hero",
    kind: "section",
    // 2:1, the shape a full-width hero band actually occupies.
    output: { width: 2400, height: 1200 },
    background: { r: 250, g: 249, b: 247 },
    gutter: 0.03,
  },
  "section.collage": {
    key: "section.collage",
    label: "Collage",
    kind: "section",
    output: { width: 1800, height: 1800 },
    background: { r: 250, g: 249, b: 247 },
    gutter: 0.035,
  },
  "section.feature": {
    key: "section.feature",
    label: "Featured section",
    kind: "section",
    output: { width: 2000, height: 1250 },
    background: { r: 250, g: 249, b: 247 },
    gutter: 0.03,
  },
};

Object.assign(SURFACES, SECTION_SURFACES);

// Garment colours J4 can actually produce. A closed list for the same reason
// the surface registry is closed: a colour that reaches the image model
// unchecked is a colour nobody verified the result of.
// Garment colours, as real RGB rather than words for a prompt (2026-08-18).
//
// The colour is applied compositionally now, so these are the actual target
// values the fabric is mapped onto — not adjectives an image model interprets
// differently every time. `expect` stays as the verification band, because a
// deterministic step should still be checked rather than assumed.
//
// White is deliberately not 255. A pure-white garment on a white backdrop has
// no edge, so it renders as a very light grey that still reads as white while
// keeping the silhouette visible.
export const GARMENT_COLORS: Record<
  string,
  { label: string; rgb: { r: number; g: number; b: number }; expect: "dark" | "light" | "mid" }
> = {
  black: { label: "black", rgb: { r: 28, g: 28, b: 30 }, expect: "dark" },
  white: { label: "white", rgb: { r: 238, g: 238, b: 236 }, expect: "light" },
  navy: { label: "navy blue", rgb: { r: 30, g: 44, b: 82 }, expect: "dark" },
  grey: { label: "heather grey", rgb: { r: 158, g: 158, b: 160 }, expect: "mid" },
  sand: { label: "sand", rgb: { r: 208, g: 190, b: 160 }, expect: "light" },
  forest: { label: "forest green", rgb: { r: 38, g: 68, b: 48 }, expect: "dark" },
};

export const DEFAULT_GARMENT_COLOR = "grey";

export function getSurface(key: string): Surface | null {
  // hasOwnProperty (2026-08-22): the key is a free string (a design's own
  // `surface`, model-authored), so a bare lookup returned the inherited Object
  // constructor for "constructor" — truthy, so `?? null` never fired and a
  // function came back from a signature promising `Surface | null`.
  if (!Object.prototype.hasOwnProperty.call(SURFACES, key)) return null;
  const surface = SURFACES[key];
  return surface && typeof surface === "object" ? surface : null;
}

// How the asset(s) sit on the surface. One asset centred is the whole of the
// first slice; the shape is deliberately general because a collage is the same
// operation with more entries and different rectangles.
export type ArrangementKind = "centered" | "grid";

export interface Arrangement {
  kind: ArrangementKind;
  /** Fraction of the output the artwork occupies. 1 fills it entirely. */
  scale: number;
  /** For grid arrangements. Ignored when centered. */
  columns?: number;
}

export const DEFAULT_ARRANGEMENT: Arrangement = { kind: "centered", scale: 0.8 };
