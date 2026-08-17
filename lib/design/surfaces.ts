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

export type SurfaceKind = "garment" | "section";

export interface Surface {
  key: string;
  label: string;
  kind: SurfaceKind;
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
   * Contains a {color} placeholder. Colour is a real input, not decoration —
   * an owner who asks for a black hoodie and gets a grey one has been told
   * something untrue about their own product.
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

export const SURFACES: Record<string, Surface> = {
  "garment.tshirt": {
    key: "garment.tshirt",
    label: "T-shirt",
    kind: "garment",
    // 12in x 16in at 150dpi — the standard DTG print area. Real numbers, not
    // decorative: this is what a fulfillment provider expects to receive.
    output: { width: 1800, height: 2400 },
    mockupArea: { x: 0.31, y: 0.26, width: 0.38, height: 0.34 },
    basePrompt:
      "A plain {color} t-shirt laid flat on a clean white background, front view, centered, the garment itself clearly and unmistakably {color}, no graphics, no text, no logo, even lighting, product photography.",
  },
  "garment.hoodie": {
    key: "garment.hoodie",
    label: "Hoodie",
    kind: "garment",
    output: { width: 1800, height: 2400 },
    mockupArea: { x: 0.33, y: 0.32, width: 0.34, height: 0.3 },
    basePrompt:
      "A plain {color} pullover hoodie laid flat on a clean white background, front view, centered, the garment itself clearly and unmistakably {color}, no graphics, no text, no logo, even lighting, product photography.",
  },
};

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
export const GARMENT_COLORS: Record<string, { label: string; /** Expected mean luminance, 0-255, for verifying the render. */ expect: "dark" | "light" | "mid" }> = {
  black: { label: "black", expect: "dark" },
  white: { label: "white", expect: "light" },
  navy: { label: "navy blue", expect: "dark" },
  grey: { label: "heather grey", expect: "mid" },
  sand: { label: "sand", expect: "light" },
  forest: { label: "forest green", expect: "dark" },
};
export const DEFAULT_GARMENT_COLOR = "grey";

export function getSurface(key: string): Surface | null {
  return SURFACES[key] ?? null;
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
