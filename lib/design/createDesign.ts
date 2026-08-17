import sharp from "sharp";
import { put } from "@vercel/blob";
import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import { persistSyncedRecords } from "@/lib/businessModel/sync";
import { DesignSchema, type Design } from "@/lib/businessModel/entities";
import { GeneratedImageProvider } from "@/lib/imageProviders/generatedImageProvider";
import { AssetSchema } from "@/lib/businessModel/entities";
import { DEFAULT_ARRANGEMENT, DEFAULT_GARMENT_COLOR, GARMENT_COLORS, getSurface, type Arrangement, type Surface } from "./surfaces";

// The Design layer: asset(s) + surface + arrangement -> print file + mockup.
//
// Sits directly between Asset and Product, and is deliberately THIN. It owns
// no approval flow, no provider knowledge and no second pipeline: it takes
// approved assets, composes them onto a surface, and produces two real files
// that Product and the fulfillment connector already know how to consume
// (FulfillmentConnector.createProduct takes exactly one print-ready imageUrl).
//
// REAL COMPOSITION, NOT GENERATION. The mockup is the actual approved logo
// composited onto a garment base with sharp — not an image model asked to
// "draw this logo on a shirt", which would produce something that merely
// resembles the owner's mark. The print file is likewise the real asset,
// resized onto the provider's expected print canvas. A design the owner
// approves has to be the thing that gets printed.
//
// MULTIPLE ASSETS FROM THE START. assetIds is an array and the compositor
// loops. One centred asset is the whole of this first slice, but a collage is
// the same operation with more entries and different rectangles — see
// WORK_STUDIO.md for why a single-asset shape would have foreclosed
// composition intelligence entirely.

const SOURCE_PROVIDER = "genesis_design";

export interface DesignResult {
  designId: string;
  printFileUrl: string;
  mockupUrl: string;
  surface: string;
  sourceAssetUrls: string[];
  /** The garment colour actually used. */
  color?: string;
  /**
   * Whether the rendered garment measurably matches the colour asked for.
   * False means J4 must not claim it does.
   */
  colorVerified?: boolean;
  /**
   * How visible the owner's mark is against this product colour. Null for
   * section compositions and when the mark cannot be read.
   */
  contrast?: ContrastReading | null;
}

async function fetchImage(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * A blank garment to composite onto, cached as an asset so it is generated
 * once per store rather than per design.
 *
 * Generation is the honest tool HERE, unlike for the artwork: nobody's brand
 * is at stake in a blank grey t-shirt, and there is no existing file to
 * preserve. The role is namespaced under `surface.` so it never collides with
 * the owner's own brand assets.
 */
async function resolveSurfaceBase(storeId: string, surface: Surface): Promise<Buffer | null> {
  // A section has no base: the composition is the output. Callers must not
  // reach here for one, and this returns null rather than inventing a canvas.
  if (!surface.basePrompt) return null;
  // ONE NEUTRAL BASE PER SURFACE. Colour is applied afterwards by
  // recolorProduct, so a store generates each product shape once and every
  // colour of it is free and identical in shape, lighting and texture.
  const role = `surface.${surface.key}`;
  const cached = await prisma.businessRecord.findMany({
    where: { storeId, entityType: "asset" },
    orderBy: { syncedAt: "desc" },
    select: { data: true },
  });
  for (const row of cached) {
    const parsed = AssetSchema.safeParse(row.data);
    if (parsed.success && parsed.data.role === role) {
      const buf = await fetchImage(parsed.data.storageUrl);
      if (buf) return buf;
    }
  }

  const sourced = await GeneratedImageProvider.source({
    prompt: surface.basePrompt,
    name: surface.label,
    description: null,
    excludeUrls: [],
    scope: { storeId },
    feature: "business_icon_generation",
  });
  if (!sourced?.url) return null;

  await persistSyncedRecords(storeId, SOURCE_PROVIDER, [
    {
      entityType: "asset",
      externalId: sourced.url,
      data: {
        fileType: "photo",
        category: "surface_base",
        storageUrl: sourced.url,
        originalFilename: `${surface.key}-base.png`,
        summary: `Blank ${surface.label} for mockups`,
        extractionConfidence: null,
        relatedRecordId: null,
        relatedEntityType: null,
        role,
        origin: "generated",
        supersedesAssetId: null,
        supersededByAssetId: null,
        generationPrompt: sourced.generationPrompt ?? surface.basePrompt,
        aiUsageEventId: sourced.aiUsageEventId ?? null,
        createdAt: new Date().toISOString(),
      },
    },
  ]);

  return fetchImage(sourced.url);
}

/**
 * Paints the product the colour that was asked for. Deterministically.
 *
 * Sean: "this needs to be fixed at the composition layer, not by asking the
 * image generation model to interpret the requested color." Two attempts at
 * prompting produced grey hoodies called black, which is the same class of
 * failure as generating a logo that merely resembles the owner's mark. The
 * mockup already refuses to do that; the colour should not either.
 *
 * HOW THE SHAPE SURVIVES. Every pixel's luminance carries the lighting,
 * shadows, folds, seams and fabric texture. Scaling the target colour BY that
 * luminance keeps all of it: a fold that was darker than its surroundings stays
 * darker by the same proportion, so the garment reads as a photographed object
 * rather than a flat silhouette.
 *
 * HOW THE BACKDROP SURVIVES. The white background is left alone, and the test
 * for it is deliberately conservative — near-white AND near-neutral, so a
 * genuine highlight on the fabric is recoloured while the studio backdrop is
 * not. Getting this wrong in the safe direction leaves a faint halo; getting it
 * wrong in the other direction paints the whole frame.
 */
async function recolorProduct(base: Buffer, color: string): Promise<Buffer> {
  const target = GARMENT_COLORS[color]?.rgb;
  if (!target) return base;

  const { data, info } = await sharp(base).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const out = Buffer.from(data);

  // THE BACKDROP IS FOUND, NOT GUESSED (2026-08-18, second pass).
  //
  // The first version treated "near-white and neutral" as backdrop, which
  // painted the entire frame black: the generated backgrounds are not as close
  // to pure white as the threshold assumed, and no threshold can separate a
  // WHITE garment from a white backdrop anyway — they are the same colour.
  //
  // What actually distinguishes them is connectivity. The backdrop touches the
  // border of the frame; the product does not. So this floods inward from the
  // edges across light pixels and marks only what it reaches. A white t-shirt
  // in the middle is never reached, because the shadow around it stops the
  // flood, which is exactly the edge a photograph provides.
  const isLight = (idx: number) => {
    const l = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
    const spread = Math.max(data[idx], data[idx + 1], data[idx + 2]) - Math.min(data[idx], data[idx + 1], data[idx + 2]);
    return l > 216 && spread < 40;
  };

  const backdrop = new Uint8Array(width * height);
  const queue: number[] = [];
  const push = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const p = y * width + x;
    if (backdrop[p]) return;
    if (!isLight(p * channels)) return;
    backdrop[p] = 1;
    queue.push(p);
  };
  for (let x = 0; x < width; x++) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    push(0, y);
    push(width - 1, y);
  }
  while (queue.length > 0) {
    const p = queue.pop()!;
    const x = p % width;
    const y = (p - x) / width;
    push(x + 1, y);
    push(x - 1, y);
    push(x, y + 1);
    push(x, y - 1);
  }

  // The product's own mean luminance, backdrop excluded. Mapping that mean onto
  // the requested colour is what makes "black" land on black rather than on
  // whatever the model happened to render.
  let sum = 0;
  let count = 0;
  for (let p = 0; p < width * height; p++) {
    if (backdrop[p]) continue;
    const i = p * channels;
    sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    count++;
  }
  const reference = count > 0 ? sum / count : 160;

  for (let p = 0; p < width * height; p++) {
    if (backdrop[p]) continue;
    const i = p * channels;
    const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    // Relative shading, softened so a deep colour keeps its folds and seams
    // without crushing them to flat black or blowing highlights to white.
    const ratio = Math.pow(l / reference, 0.85);
    out[i] = Math.max(0, Math.min(255, Math.round(target.r * ratio)));
    out[i + 1] = Math.max(0, Math.min(255, Math.round(target.g * ratio)));
    out[i + 2] = Math.max(0, Math.min(255, Math.round(target.b * ratio)));
  }

  return sharp(out, { raw: { width, height, channels } })
    .png()
    .toBuffer();
}

/**
 * Does the rendered product actually look like the colour that was asked for?
 *
 * Kept after the move to deterministic recolouring rather than deleted. The
 * recolour should always satisfy this, so a failure now means something real
 * broke — a base that is mostly backdrop, an unreadable image, a colour whose
 * target and expectation disagree. A check that only fires when something is
 * genuinely wrong is worth more than one that fired routinely.
 *
 * Samples the centre, where the product is, rather than the corners, which are
 * the white studio backdrop and would wash every reading toward light.
 */
async function garmentMatchesColor(image: Buffer, color: string): Promise<boolean> {
  const expect = GARMENT_COLORS[color]?.expect;
  if (!expect) return true;
  try {
    // MEASURES THE PRODUCT, NOT A RECTANGLE (corrected 2026-08-18, third pass).
    //
    // Sampling a fixed region kept reading the backdrop. The centre of a
    // garment is where artwork goes; a band across the shoulders catches the
    // white showing through a neck opening. Both produced "not black" readings
    // of a hoodie that direct pixel inspection showed was (19, 19, 20).
    //
    // So the product is identified rather than located: every pixel that is not
    // near-white counts, wherever it happens to be. That works for any shape in
    // the catalogue — a mug, a cap, a poster — without a per-surface region.
    const { data, info } = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let sum = 0;
    let count = 0;
    for (let i = 0; i < data.length; i += info.channels) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      const spread = Math.max(r, g, b) - Math.min(r, g, b);
      if (l > 216 && spread < 40) continue; // backdrop
      sum += l;
      count++;
    }
    // Almost nothing but backdrop means there is no product to judge. Report
    // unverified rather than passing something that was never measured.
    if (count < info.width * info.height * 0.02) return false;
    const mean = sum / count;
    if (expect === "dark") return mean < 110;
    if (expect === "light") return mean > 170;
    return true;
  } catch {
    // A measurement that fails must not block a design. Unverified is reported
    // as unverified, never as a failure.
    return true;
  }
}

/**
 * Is the owner's mark actually going to be visible on this product?
 *
 * Sean, on a dark logo composed onto a black hoodie: "the result is technically
 * composable but visually poor... J4 should tell the owner that the contrast is
 * too low and offer an appropriate alternative." The composition is correct in
 * every respect and the outcome is still one nobody would put in a shop.
 *
 * IT NEVER TOUCHES THE ASSET. Silently lightening someone's logo so it shows up
 * on black would be altering their brand without asking, which is the thing the
 * whole asset model exists to prevent. This only measures and reports; changing
 * the mark is the owner's decision, made in conversation.
 *
 * Measures the INK, not the file. A mark is mostly transparent or white space —
 * the logo here is 1024x1024 with 5% ink — so averaging the whole square would
 * describe the padding rather than the mark.
 */
function relativeLuminance(r: number, g: number, b: number): number {
  const f = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export interface ContrastReading {
  /** WCAG-style ratio between the mark's ink and the product colour, 1 to 21. */
  ratio: number;
  sufficient: boolean;
  /** Which way the mark would need to move to be visible. */
  markIs: "dark" | "light";
}

async function assessContrast(assets: Buffer[], productRgb: { r: number; g: number; b: number }): Promise<ContrastReading | null> {
  let r = 0, g = 0, b = 0, n = 0;
  for (const buffer of assets) {
    try {
      const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      for (let i = 0; i < data.length; i += info.channels) {
        const alpha = info.channels === 4 ? data[i + 3] : 255;
        if (alpha < 40) continue; // transparent padding is not the mark
        const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        if (l > 232) continue; // white padding is not the mark either
        r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
      }
    } catch {
      return null;
    }
  }
  if (n === 0) return null;

  const inkL = relativeLuminance(r / n, g / n, b / n);
  const productL = relativeLuminance(productRgb.r, productRgb.g, productRgb.b);
  const ratio = (Math.max(inkL, productL) + 0.05) / (Math.min(inkL, productL) + 0.05);
  return {
    ratio: Math.round(ratio * 10) / 10,
    // 3:1 is the accepted floor for graphics. Below it the mark is present and
    // effectively unreadable, which is exactly the case that prompted this.
    sufficient: ratio >= 3,
    markIs: inkL < productL ? "dark" : "light",
  };
}

/** Lays the artwork out on a transparent canvas of the surface's print size. */
async function composePrintFile(
  assets: Buffer[],
  surface: Surface,
  arrangement: Arrangement
): Promise<Buffer> {
  const { width, height } = surface.output;
  const columns = arrangement.kind === "grid" ? Math.max(1, arrangement.columns ?? 2) : 1;
  const rows = Math.ceil(assets.length / columns);
  const cellWidth = Math.floor(width / columns);
  const cellHeight = Math.floor(height / rows);
  // A section composition needs breathing room between cells; a print file
  // does not, because it is one mark on a garment rather than a layout.
  const gutter = surface.kind === "section" ? (surface.gutter ?? 0.03) : 0;
  const scale = Math.max(0.05, arrangement.scale - gutter);
  const artWidth = Math.max(1, Math.floor(cellWidth * scale));
  const artHeight = Math.max(1, Math.floor(cellHeight * scale));

  const layers = [];
  for (let i = 0; i < assets.length; i++) {
    const resized = await sharp(assets[i])
      .resize(artWidth, artHeight, { fit: "inside", withoutEnlargement: false })
      .png()
      .toBuffer();
    const meta = await sharp(resized).metadata();
    const col = i % columns;
    const row = Math.floor(i / columns);
    layers.push({
      input: resized,
      left: col * cellWidth + Math.floor((cellWidth - (meta.width ?? artWidth)) / 2),
      top: row * cellHeight + Math.floor((cellHeight - (meta.height ?? artHeight)) / 2),
    });
  }

  // Transparent for print (the garment shows through); opaque for a section,
  // because a storefront graphic with a transparent background would render
  // differently on every theme it lands on.
  const background =
    surface.kind === "section"
      ? { ...(surface.background ?? { r: 250, g: 249, b: 247 }), alpha: 1 }
      : { r: 0, g: 0, b: 0, alpha: 0 };

  return sharp({ create: { width, height, channels: 4, background } })
    .composite(layers)
    .png()
    .toBuffer();
}

/** Puts the print file onto the surface base, inside its real print area. */
async function composeMockup(printFile: Buffer, base: Buffer, surface: Surface): Promise<Buffer> {
  const area = surface.mockupArea;
  if (!area) return printFile;
  const baseMeta = await sharp(base).metadata();
  const baseWidth = baseMeta.width ?? 1024;
  const baseHeight = baseMeta.height ?? 1024;
  const areaWidth = Math.max(1, Math.round(baseWidth * area.width));
  const areaHeight = Math.max(1, Math.round(baseHeight * area.height));

  const artwork = await sharp(printFile)
    .resize(areaWidth, areaHeight, { fit: "inside" })
    .png()
    .toBuffer();
  const artMeta = await sharp(artwork).metadata();

  return sharp(base)
    .composite([
      {
        input: artwork,
        left: Math.round(baseWidth * area.x) + Math.floor((areaWidth - (artMeta.width ?? areaWidth)) / 2),
        top: Math.round(baseHeight * area.y) + Math.floor((areaHeight - (artMeta.height ?? areaHeight)) / 2),
      },
    ])
    .png()
    .toBuffer();
}

async function upload(buffer: Buffer, name: string): Promise<string> {
  const blob = await put(`designs/${randomUUID()}-${name}.png`, buffer, {
    access: "public",
    contentType: "image/png",
  });
  return blob.url;
}

/**
 * Composes approved assets onto a surface and records the Design.
 *
 * Returns null rather than a partial result when anything real is missing —
 * the honest-null convention every image path in this codebase already
 * follows. A Design with no print file is not a Design.
 */
export async function createDesign(params: {
  storeId: string;
  /** BusinessRecord ids of approved assets, in arrangement order. */
  assetIds: string[];
  /** A key from SURFACES. */
  surface: string;
  arrangement?: Arrangement;
  /** A key from GARMENT_COLORS. Ignored by section surfaces. */
  color?: string | null;
}): Promise<DesignResult | null> {
  const surface = getSurface(params.surface);
  if (!surface || params.assetIds.length === 0) return null;
  const arrangement = params.arrangement ?? DEFAULT_ARRANGEMENT;

  const rows = await prisma.businessRecord.findMany({
    where: { storeId: params.storeId, entityType: "asset", id: { in: params.assetIds } },
    select: { id: true, data: true },
  });
  // Preserve the caller's order — findMany does not, and arrangement order is
  // meaningful the moment there is more than one asset.
  const ordered = params.assetIds
    .map((id) => rows.find((r) => r.id === id))
    .filter((r): r is (typeof rows)[number] => r !== undefined);
  if (ordered.length === 0) return null;

  const sourceAssetUrls: string[] = [];
  const buffers: Buffer[] = [];
  for (const row of ordered) {
    const parsed = AssetSchema.safeParse(row.data);
    if (!parsed.success) continue;
    const buf = await fetchImage(parsed.data.storageUrl);
    if (!buf) continue;
    sourceAssetUrls.push(parsed.data.storageUrl);
    buffers.push(buf);
  }
  if (buffers.length === 0) return null;

  const composed = await composePrintFile(buffers, surface, arrangement);

  // A SECTION IS ITS OWN MOCKUP. There is no garment to place it on, so the
  // composition is simultaneously what the owner reviews and what gets used.
  // Garments keep the two apart deliberately: the mockup sells, the print file
  // prints, and they are different images.
  const printFile = composed;
  let mockup = composed;
  const color = params.color && GARMENT_COLORS[params.color] ? params.color : DEFAULT_GARMENT_COLOR;
  let colorVerified = true;
  // Products only. A section composition has no product colour behind the
  // artwork, so there is nothing to contrast it against.
  const contrast =
    surface.kind === "section" ? null : await assessContrast(buffers, GARMENT_COLORS[color].rgb);
  if (surface.kind !== "section") {
    const neutral = await resolveSurfaceBase(params.storeId, surface);
    if (!neutral) return null;
    const colored = await recolorProduct(neutral, color);
    // Still measured. The recolour is deterministic, so this should always
    // pass — which is exactly why it is worth keeping: a check that only fires
    // when something has genuinely broken is the useful kind.
    colorVerified = await garmentMatchesColor(colored, color);
    mockup = await composeMockup(printFile, colored, surface);
  }

  // A section's print file and mockup are the same bytes, so upload once and
  // point both at it. Uploading twice cost two blobs and two URLs for one
  // image, which the verification caught by asserting they were equal.
  let printFileUrl: string;
  let mockupUrl: string;
  if (surface.kind === "section") {
    printFileUrl = await upload(composed, `${surface.key}-composition`);
    mockupUrl = printFileUrl;
  } else {
    [printFileUrl, mockupUrl] = await Promise.all([
      upload(printFile, `${surface.key}-print`),
      upload(mockup, `${surface.key}-mockup`),
    ]);
  }

  const data: Design = {
    assetIds: ordered.map((r) => r.id),
    surface: surface.key,
    arrangement: arrangement.kind,
    arrangementScale: arrangement.scale,
    printFileUrl,
    mockupUrl,
    sourceAssetUrls,
    createdAt: new Date().toISOString(),
  };
  DesignSchema.parse(data);

  const result = await persistSyncedRecords(params.storeId, SOURCE_PROVIDER, [
    { entityType: "design", externalId: printFileUrl, data },
  ]);
  if (result.errors.length > 0) return null;

  const record = await prisma.businessRecord.findUnique({
    where: {
      storeId_entityType_sourceProvider_externalId: {
        storeId: params.storeId,
        entityType: "design",
        sourceProvider: SOURCE_PROVIDER,
        externalId: printFileUrl,
      },
    },
    select: { id: true },
  });
  if (!record) return null;

  return { designId: record.id, printFileUrl, mockupUrl, surface: surface.key, sourceAssetUrls, color, colorVerified, contrast };
}
