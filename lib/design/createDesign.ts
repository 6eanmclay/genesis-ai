import sharp from "sharp";
import { put } from "@vercel/blob";
import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import { persistSyncedRecords } from "@/lib/businessModel/sync";
import { DesignSchema, type Design } from "@/lib/businessModel/entities";
import { GeneratedImageProvider } from "@/lib/imageProviders/generatedImageProvider";
import { AssetSchema } from "@/lib/businessModel/entities";
import { DEFAULT_ARRANGEMENT, getSurface, type Arrangement, type Surface } from "./surfaces";

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
  const role = `surface.${surface.key}`;
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
  const artWidth = Math.max(1, Math.floor(cellWidth * arrangement.scale));
  const artHeight = Math.max(1, Math.floor(cellHeight * arrangement.scale));

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

  return sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite(layers)
    .png()
    .toBuffer();
}

/** Puts the print file onto the surface base, inside its real print area. */
async function composeMockup(printFile: Buffer, base: Buffer, surface: Surface): Promise<Buffer> {
  const baseMeta = await sharp(base).metadata();
  const baseWidth = baseMeta.width ?? 1024;
  const baseHeight = baseMeta.height ?? 1024;
  const areaWidth = Math.max(1, Math.round(baseWidth * surface.mockupArea.width));
  const areaHeight = Math.max(1, Math.round(baseHeight * surface.mockupArea.height));

  const artwork = await sharp(printFile)
    .resize(areaWidth, areaHeight, { fit: "inside" })
    .png()
    .toBuffer();
  const artMeta = await sharp(artwork).metadata();

  return sharp(base)
    .composite([
      {
        input: artwork,
        left: Math.round(baseWidth * surface.mockupArea.x) + Math.floor((areaWidth - (artMeta.width ?? areaWidth)) / 2),
        top: Math.round(baseHeight * surface.mockupArea.y) + Math.floor((areaHeight - (artMeta.height ?? areaHeight)) / 2),
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

  const printFile = await composePrintFile(buffers, surface, arrangement);
  const base = await resolveSurfaceBase(params.storeId, surface);
  if (!base) return null;
  const mockup = await composeMockup(printFile, base, surface);

  const [printFileUrl, mockupUrl] = await Promise.all([
    upload(printFile, `${surface.key}-print`),
    upload(mockup, `${surface.key}-mockup`),
  ]);

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

  return { designId: record.id, printFileUrl, mockupUrl, surface: surface.key, sourceAssetUrls };
}
