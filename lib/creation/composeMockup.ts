import sharp from "sharp";
import type { DesignLayer } from "@/lib/creation/design";
// The geometry lives apart so the client canvas can share it without pulling
// sharp into the browser bundle. Re-exported: this is where callers look.
import { PRINT_AREA_BOX, MOCKUP_SIZE } from "./mockupGeometry";
export { PRINT_AREA_BOX, MOCKUP_SIZE };

// THE PICTURE OF THE PRODUCT — the one the owner was actually looking at.
//
// ============ WHAT WENT WRONG (2026-08-28) =============================
//
// Sean: "The product created from Creation Station should arrive in the store
// with the correct generated product image(s), including the front/back design
// that was actually created... verify that the image attached to the Store
// Product is the actual composition the user previewed, not a generic supplier
// image or a newly generated approximation."
//
// Two separate faults produced "Photos (0/10), No image":
//
//   1. lib/creation/saveDesign.ts set Product.imageUrl and NEVER wrote a
//      ProductImage row. The gallery counts ProductImage rows, so the count was
//      zero however the scalar column was filled.
//   2. Nothing composed a mockup at all. The print file — artwork alone on
//      transparency — is what a supplier prints, not what a customer browses.
//
// This is the second half. It rebuilds, server-side, exactly what
// CreationCanvas draws: the supplier's blank tinted to the chosen colour, with
// the artwork laid into the same print-area rectangle at the same fractions.
//
// ============ WHY THE GEOMETRY IS SHARED, NOT COPIED ===================
//
// CreationCanvas positions the print area with a comment calling it "a
// deliberate constant, and the one number here that is presentation rather than
// data". A constant that decides where artwork sits, written down twice, is a
// preview and a product that drift apart the first time either is adjusted —
// and the drift would show up as a mockup that does not match what was
// approved. So it lives here, once, and the canvas imports it.

/**
 * The supplier's blank, in a colour they actually manufacture, on transparency.
 *
 * ============ THE BLANK IS A SHADING LAYER =============================
 *
 * Printful's `base_whitebg.png` carries a full alpha channel whose OPAQUE part
 * is the background — the garment itself sits at around 10% alpha. That single
 * fact explains four rounds of failed attempts: masking by alpha selects the
 * background, and multiply over a 10%-opaque layer only ever reaches the few
 * bright pixels, which is why an early attempt tinted the drawstrings and
 * nothing else.
 *
 * Per pixel: the colour is darkened by the shading lying over it, and the
 * opacity is INVERTED because the opaque part is the part to throw away.
 *
 * This is the same arithmetic app/api/creation/blank/route.ts serves to the
 * browser, kept here so the preview and the product are composed by one
 * definition rather than two that agree today.
 */
export async function tintBlank(blank: Buffer, colorHex: string): Promise<Buffer> {
  const hex = colorHex.replace("#", "");
  const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  if ([r, g, b].some(Number.isNaN)) throw new Error(`"${colorHex}" is not a colour.`);

  const { data, info } = await sharp(blank).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.allocUnsafe(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const shade = data[i + 3] / 255;
    const grey = data[i];
    out[i] = Math.round(r * (1 - shade) + grey * shade);
    out[i + 1] = Math.round(g * (1 - shade) + grey * shade);
    out[i + 2] = Math.round(b * (1 - shade) + grey * shade);
    out[i + 3] = 255 - data[i + 3];
  }

  return sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toBuffer();
}

/**
 * One placement's mockup: the coloured garment with the artwork on it.
 *
 * The artwork is placed by the SAME fractions the design stores and the canvas
 * draws with, into the same rectangle — so this is the composition the owner
 * approved rather than a fresh interpretation of it.
 */
export async function composeMockup(params: {
  /** The supplier's blank for this placement, as bytes. */
  blank: Buffer;
  colorHex: string;
  layers: DesignLayer[];
  fetchImage: (url: string) => Promise<Buffer>;
}): Promise<Buffer> {
  const { blank, colorHex, layers, fetchImage } = params;
  const { width: W, height: H } = MOCKUP_SIZE;

  const garment = await sharp(await tintBlank(blank, colorHex))
    .resize(W, H, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  // The print area, in mockup pixels.
  const areaX = PRINT_AREA_BOX.x * W;
  const areaY = PRINT_AREA_BOX.y * H;
  const areaW = PRINT_AREA_BOX.width * W;
  const areaH = PRINT_AREA_BOX.height * H;

  const composites: sharp.OverlayOptions[] = [{ input: garment, left: 0, top: 0 }];

  for (const layer of layers) {
    const source = await fetchImage(layer.assetUrl);
    const width = Math.max(1, Math.round(layer.width * areaW));
    const height = Math.max(1, Math.round(layer.height * areaH));

    let image = sharp(source).ensureAlpha().resize(width, height, {
      fit: "inside",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    });
    if (layer.flipX) image = image.flop();
    if (layer.flipY) image = image.flip();
    if (layer.rotation) {
      image = image.rotate(layer.rotation, { background: { r: 0, g: 0, b: 0, alpha: 0 } });
    }

    const rendered = await image.png().toBuffer();
    const meta = await sharp(rendered).metadata();
    const renderedW = meta.width ?? width;
    const renderedH = meta.height ?? height;

    // Centre-anchored, so a rotated layer stays where it was put rather than
    // drifting by half its new bounding box.
    const centreX = areaX + layer.x * areaW + width / 2;
    const centreY = areaY + layer.y * areaH + height / 2;

    composites.push({
      input: rendered,
      left: clamp(Math.round(centreX - renderedW / 2), W, renderedW),
      top: clamp(Math.round(centreY - renderedH / 2), H, renderedH),
    });
  }

  // A WHITE GROUND, not transparency. This one is looked at rather than
  // printed, and a transparent PNG on a storefront card renders against
  // whatever is behind it — which for a black hoodie on a dark theme is
  // nothing at all.
  return sharp({
    create: { width: W, height: H, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
  })
    .composite(composites)
    .png()
    .toBuffer();
}

/** Keep a composite inside the canvas; sharp throws rather than clipping. */
function clamp(value: number, canvasSize: number, layerSize: number): number {
  const max = Math.max(0, canvasSize - layerSize);
  return Math.min(Math.max(value, 0), max);
}
