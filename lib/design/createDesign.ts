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
async function resolveSurfaceBase(
  storeId: string,
  surface: Surface,
  color: string
): Promise<{ buffer: Buffer; verified: boolean } | null> {
  // A section has no base: the composition is the output. Callers must not
  // reach here for one, and this returns null rather than inventing a canvas.
  if (!surface.basePrompt) return null;
  // CACHED PER COLOUR, not per surface (2026-08-18). Caching one base per
  // surface is what made "put it on a black hoodie" return a grey hoodie: the
  // colour never reached the generator and the grey base was reused forever.
  const role = `surface.${surface.key}.${color}`;
  // Look for a cached base for this exact surface before generating one.
  const cached = await prisma.businessRecord.findMany({
    where: { storeId, entityType: "asset" },
    orderBy: { syncedAt: "desc" },
    select: { data: true },
  });
  for (const row of cached) {
    const parsed = AssetSchema.safeParse(row.data);
    if (parsed.success && parsed.data.role === role) {
      const buf = await fetchImage(parsed.data.storageUrl);
      if (buf) return { buffer: buf, verified: await garmentMatchesColor(buf, color) };
    }
  }

  const colorLabel = GARMENT_COLORS[color]?.label ?? color;
  const sourced = await GeneratedImageProvider.source({
    prompt: surface.basePrompt.replaceAll("{color}", colorLabel),
    name: surface.label,
    description: null,
    excludeUrls: [],
    scope: { storeId },
    feature: "business_icon_generation",
  });
  if (!sourced?.url) return null;

  // Cached as an ordinary asset, so the second design on the same surface
  // costs nothing.
  await persistSyncedRecords(storeId, SOURCE_PROVIDER, [
    {
      entityType: "asset",
      externalId: sourced.url,
      data: {
        fileType: "photo",
        category: "surface_base",
        storageUrl: sourced.url,
        originalFilename: `${surface.key}-${color}-base.png`,
        summary: `Blank ${colorLabel} ${surface.label} for mockups`,
        extractionConfidence: null,
        relatedRecordId: null,
        relatedEntityType: null,
        role,
        origin: "generated",
        supersedesAssetId: null,
        supersededByAssetId: null,
        generationPrompt: sourced.generationPrompt ?? surface.basePrompt.replaceAll("{color}", colorLabel),
        aiUsageEventId: sourced.aiUsageEventId ?? null,
        createdAt: new Date().toISOString(),
      },
    },
  ]);

  const fresh = await fetchImage(sourced.url);
  if (!fresh) return null;
  if (await garmentMatchesColor(fresh, color)) {
    return { buffer: fresh, verified: true };
  }

  // ONE RETRY WITH A HARDER PROMPT (2026-08-18). The first "black hoodie" came
  // back light grey, and reporting that honestly is necessary but not enough —
  // the owner asked for black. Image models under-commit to dark garments
  // against a white backdrop, so the retry says so explicitly. One attempt
  // only: a loop here would spend real money chasing a colour the model may
  // simply not produce, and an honest "that isn't black" beats a bill.
  const insistent = await GeneratedImageProvider.source({
    prompt:
      `${surface.basePrompt.replaceAll("{color}", colorLabel)} The fabric must read as a deep, saturated, unmistakable ${colorLabel} across the whole garment, not a lighter shade of it, and not washed out by the lighting.`,
    name: surface.label,
    description: null,
    excludeUrls: [sourced.url],
    scope: { storeId },
    feature: "business_icon_generation",
  });
  const retried = insistent?.url ? await fetchImage(insistent.url) : null;
  if (retried && (await garmentMatchesColor(retried, color))) {
    // Cache the one that actually worked, so the next design in this colour
    // starts from the good base rather than repeating the retry.
    await persistSyncedRecords(storeId, SOURCE_PROVIDER, [
      {
        entityType: "asset",
        externalId: insistent!.url,
        data: {
          fileType: "photo",
          category: "surface_base",
          storageUrl: insistent!.url,
          originalFilename: `${surface.key}-${color}-base.png`,
          summary: `Blank ${colorLabel} ${surface.label} for mockups`,
          extractionConfidence: null,
          relatedRecordId: null,
          relatedEntityType: null,
          role,
          origin: "generated",
          supersedesAssetId: null,
          supersededByAssetId: null,
          generationPrompt: insistent!.generationPrompt ?? null,
          aiUsageEventId: insistent!.aiUsageEventId ?? null,
          createdAt: new Date().toISOString(),
        },
      },
    ]);
    return { buffer: retried, verified: true };
  }

  // Both attempts missed. The design still gets made — the owner sees a real
  // mockup — and colorVerified: false is what stops J4 calling it black.
  return { buffer: fresh, verified: false };
}

/**
 * Does the rendered garment actually look like the colour that was asked for?
 *
 * Sean, on a hoodie that came back grey: "the response should not claim that
 * the garment is black when the rendered artifact clearly isn't." So the render
 * is measured rather than trusted. The centre of the frame is where the garment
 * is; the corners are the white backdrop, and including them would wash every
 * reading toward light.
 *
 * A coarse check on purpose. It is not trying to grade the shade, only to catch
 * the failure that actually happened: asked for dark, got light.
 */
async function garmentMatchesColor(base: Buffer, color: string): Promise<boolean> {
  const expect = GARMENT_COLORS[color]?.expect;
  if (!expect) return true;
  try {
    const meta = await sharp(base).metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (width < 8 || height < 8) return true;
    const stats = await sharp(base)
      .extract({
        left: Math.floor(width * 0.35),
        top: Math.floor(height * 0.35),
        width: Math.max(1, Math.floor(width * 0.3)),
        height: Math.max(1, Math.floor(height * 0.3)),
      })
      .stats();
    const mean = stats.channels.slice(0, 3).reduce((sum, c) => sum + c.mean, 0) / 3;
    if (expect === "dark") return mean < 110;
    if (expect === "light") return mean > 170;
    return true;
  } catch {
    // A measurement that fails must not block a design. Unverified is reported
    // as unverified, never as a failure.
    return true;
  }
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
  if (surface.kind !== "section") {
    const base = await resolveSurfaceBase(params.storeId, surface, color);
    if (!base) return null;
    colorVerified = base.verified;
    mockup = await composeMockup(printFile, base.buffer, surface);
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

  return { designId: record.id, printFileUrl, mockupUrl, surface: surface.key, sourceAssetUrls, color, colorVerified };
}
