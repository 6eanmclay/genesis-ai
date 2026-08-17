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
  mockupArea: { x: number; y: number; width: number; height: number };
  /** How to render a blank base for this surface when one is not cached yet. */
  basePrompt: string;
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
      "A plain heather-grey t-shirt laid flat on a clean white background, front view, centered, no graphics, no text, no logo, even lighting, product photography.",
  },
  "garment.hoodie": {
    key: "garment.hoodie",
    label: "Hoodie",
    kind: "garment",
    output: { width: 1800, height: 2400 },
    mockupArea: { x: 0.33, y: 0.32, width: 0.34, height: 0.3 },
    basePrompt:
      "A plain heather-grey pullover hoodie laid flat on a clean white background, front view, centered, no graphics, no text, no logo, even lighting, product photography.",
  },
};

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
