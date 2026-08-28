import sharp from "sharp";
import type { DesignLayer } from "@/lib/creation/design";

// THE FILE THE SUPPLIER ACTUALLY PRINTS.
//
// ============ WHY THIS HAS TO EXIST (2026-08-28) ========================
//
// A placement can hold several layers — the editor allows it — and Printful
// takes ONE file per placement. So a two-layer front is either composed into
// one image or silently reduced to one layer, and Sean's rule leaves no room
// for the second: "If the owner puts artwork on front and back, Create needs to
// create the actual two-sided product — not silently reduce it to one
// placement." The same reasoning applies within a placement.
//
// ============ THE CANVAS IS THE SUPPLIER'S, NOT OURS ====================
//
// Measured on 2026-08-28 against the live account, product 146:
//
//   front -> printfile 139, 2100 x 2100   (square)
//   back  -> printfile   1, 1800 x 2400   (3:4)
//
// FRONT AND BACK ARE NOT THE SAME SHAPE. That is the finding that makes this
// function take a size per placement rather than a size per garment. A design
// laid out identically on both sides is not the same design on both sides, and
// composing both against one canvas would stretch or crop one of them.
//
// The editor stores every layer as fractions of its print area, which is what
// makes this possible at all: the same design composes correctly onto any
// canvas the supplier declares, including one whose dimensions change later.

/** The canvas a supplier wants for one placement, in real pixels. */
export interface PrintCanvas {
  width: number;
  height: number;
}

/**
 * Compose one placement's layers into a single print-ready PNG.
 *
 * Transparent background, always. The garment supplies the colour behind the
 * artwork, and a white rectangle printed onto a black hoodie is the exact
 * failure the blank renderer already had to be corrected for.
 */
export async function composePrintFile(
  layers: DesignLayer[],
  canvas: PrintCanvas,
  fetchImage: (url: string) => Promise<Buffer>,
): Promise<Buffer> {
  const composites: sharp.OverlayOptions[] = [];

  for (const layer of layers) {
    const source = await fetchImage(layer.assetUrl);

    // Fractions to pixels, against THIS placement's canvas.
    const width = Math.max(1, Math.round(layer.width * canvas.width));
    const height = Math.max(1, Math.round(layer.height * canvas.height));

    let image = sharp(source).ensureAlpha().resize(width, height, {
      // `fit` rather than `cover`: the owner sized the box, and cropping their
      // artwork to fill it would print something they did not place.
      fit: "inside",
      withoutEnlargement: false,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    });

    if (layer.flipX) image = image.flop();
    if (layer.flipY) image = image.flip();
    if (layer.rotation) {
      // Transparent background on rotation, or the corners print as black.
      image = image.rotate(layer.rotation, { background: { r: 0, g: 0, b: 0, alpha: 0 } });
    }

    const rendered = await image.png().toBuffer();
    const meta = await sharp(rendered).metadata();

    // Rotation changes the bounding box, so the top-left is recomputed from the
    // rendered size rather than the requested one — otherwise a rotated layer
    // drifts away from where the owner put it.
    const renderedWidth = meta.width ?? width;
    const renderedHeight = meta.height ?? height;
    const centreX = layer.x * canvas.width + width / 2;
    const centreY = layer.y * canvas.height + height / 2;

    composites.push({
      input: rendered,
      left: clamp(Math.round(centreX - renderedWidth / 2), canvas.width, renderedWidth),
      top: clamp(Math.round(centreY - renderedHeight / 2), canvas.height, renderedHeight),
    });
  }

  return sharp({
    create: {
      width: canvas.width,
      height: canvas.height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(composites)
    .png()
    .toBuffer();
}

/**
 * Keep a layer on the canvas.
 *
 * sharp REFUSES a composite whose offset puts it outside the canvas — it
 * throws rather than clipping — so a layer dragged half off the edge would
 * fail the whole creation instead of printing as it looked. Clamping keeps the
 * artwork on the print file; the editor's own safe-margin guides are what stop
 * it reaching the edge in the first place.
 */
function clamp(value: number, canvasSize: number, layerSize: number): number {
  const max = Math.max(0, canvasSize - layerSize);
  return Math.min(Math.max(value, 0), max);
}
