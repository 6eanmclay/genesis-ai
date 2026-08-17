import { prisma } from "@/lib/prisma";
import { persistSyncedRecords } from "@/lib/businessModel/sync";
import { AssetSchema } from "@/lib/businessModel/entities";
import { designateAsset } from "@/lib/businessModel/assets";
import { createDesign, type DesignResult } from "./createDesign";
import { getSurface } from "./surfaces";

// Storefront compositions (2026-08-18) — the collage/hero/feature path.
//
// It is deliberately THIN, and everything real happens in createDesign. There
// is no second creative system here: a collage is assets + surface +
// arrangement, exactly like a T-shirt, with a storefront surface instead of a
// garment. What this file adds is only the two things a storefront composition
// needs that a garment does not:
//
//   1. Choosing which of the owner's images to compose, by subject.
//   2. Designating an approved composition as a storefront ASSET rather than
//      turning it into a Product.
//
// Point 2 is the distinction Sean called huge: "J4 needs to understand the
// difference between 'this is something the customer can buy' and 'this is
// something that makes the store look better and tells the brand story.'"

const SOURCE_PROVIDER = "genesis_storefront_media";

export interface CompositionCandidate {
  assetId: string;
  url: string;
  label: string;
}

/**
 * The owner's images that can go into a composition, best match first.
 *
 * Reads existing assets AND product photos, because most stores have real
 * product imagery long before they have designated assets — and a product
 * photo is genuinely one of the owner's images. Product photos are registered
 * as assets on the way through, so the Design layer has a real asset id to
 * record provenance against rather than a bare URL. Same asset model, no
 * separate path.
 *
 * `subject` is matched against names and summaries rather than interpreted. A
 * miss returns everything rather than nothing: composing the wrong three
 * photos is recoverable and visible, and telling the owner "I couldn't find
 * bracelets" when they have four is worse.
 */
export async function resolveCompositionAssets(params: {
  storeId: string;
  subject?: string | null;
  limit: number;
}): Promise<CompositionCandidate[]> {
  const { storeId, subject, limit } = params;
  const needle = subject?.trim().toLowerCase() ?? "";

  const assetRows = await prisma.businessRecord.findMany({
    where: { storeId, entityType: "asset" },
    orderBy: { syncedAt: "desc" },
    select: { id: true, data: true },
  });

  const fromAssets: CompositionCandidate[] = [];
  for (const row of assetRows) {
    const parsed = AssetSchema.safeParse(row.data);
    if (!parsed.success) continue;
    const a = parsed.data;
    if (a.fileType !== "photo") continue;
    // A blank garment base is scaffolding, never content.
    if (a.role?.startsWith("surface.")) continue;
    fromAssets.push({ assetId: row.id, url: a.storageUrl, label: a.summary ?? a.originalFilename });
  }

  const products = await prisma.product.findMany({
    where: { storeId, imageUrl: { not: null } },
    orderBy: { position: "asc" },
    select: { name: true, imageUrl: true, description: true },
  });

  const fromProducts: CompositionCandidate[] = [];
  for (const p of products) {
    if (!p.imageUrl) continue;
    if (fromAssets.some((c) => c.url === p.imageUrl)) continue;
    // Registered as a real asset so a Design can point at it.
    await persistSyncedRecords(storeId, SOURCE_PROVIDER, [
      {
        entityType: "asset",
        externalId: p.imageUrl,
        data: {
          fileType: "photo",
          category: "product_photo",
          storageUrl: p.imageUrl,
          originalFilename: `${p.name}.png`,
          summary: p.name,
          extractionConfidence: null,
          relatedRecordId: null,
          relatedEntityType: null,
          role: "product.photo",
          origin: "uploaded",
          supersedesAssetId: null,
          supersededByAssetId: null,
          generationPrompt: null,
          aiUsageEventId: null,
          createdAt: new Date().toISOString(),
        },
      },
    ]);
    const rec = await prisma.businessRecord.findUnique({
      where: {
        storeId_entityType_sourceProvider_externalId: {
          storeId,
          entityType: "asset",
          sourceProvider: SOURCE_PROVIDER,
          externalId: p.imageUrl,
        },
      },
      select: { id: true },
    });
    if (rec) fromProducts.push({ assetId: rec.id, url: p.imageUrl, label: p.name });
  }

  const all = [...fromProducts, ...fromAssets];
  if (!needle) return all.slice(0, limit);

  const matched = all.filter((c) => c.label.toLowerCase().includes(needle));
  return (matched.length > 0 ? matched : all).slice(0, limit);
}

/** Composes the owner's images onto a storefront surface. */
export async function createComposition(params: {
  storeId: string;
  surface: string;
  columns: number;
  subject?: string | null;
}): Promise<{ design: DesignResult; used: CompositionCandidate[] } | null> {
  const surface = getSurface(params.surface);
  if (!surface || surface.kind !== "section") return null;

  // Enough cells to fill the grid without leaving a hole: columns x 2 rows for
  // a collage, one row for a wide hero.
  const rows = surface.key === "section.hero" ? 1 : 2;
  const used = await resolveCompositionAssets({
    storeId: params.storeId,
    subject: params.subject,
    limit: Math.max(1, params.columns * rows),
  });
  if (used.length === 0) return null;

  const design = await createDesign({
    storeId: params.storeId,
    assetIds: used.map((c) => c.assetId),
    surface: surface.key,
    arrangement: { kind: "grid", scale: 1, columns: params.columns },
  });
  if (!design) return null;
  return { design, used };
}

/**
 * An approved composition becomes a storefront asset, not a product.
 *
 * Recorded through the same asset path everything else uses, so it gets a role,
 * supersession and provenance for free — a new hero takes over the role and the
 * previous one points forward rather than being deleted.
 */
export async function approveCompositionAsAsset(params: {
  storeId: string;
  designId: string;
  role: string;
  summary: string;
  imageUrl: string;
}): Promise<string | null> {
  const result = await persistSyncedRecords(params.storeId, SOURCE_PROVIDER, [
    {
      entityType: "asset",
      externalId: params.imageUrl,
      data: {
        fileType: "photo",
        category: "storefront_graphic",
        storageUrl: params.imageUrl,
        originalFilename: `${params.role.replace(/\./g, "-")}.png`,
        summary: params.summary,
        extractionConfidence: null,
        // Provenance: which Design produced it, using the same xxxId convention
        // findRelated already understands.
        relatedRecordId: params.designId,
        relatedEntityType: "design",
        role: params.role,
        origin: "generated",
        supersedesAssetId: null,
        supersededByAssetId: null,
        generationPrompt: null,
        aiUsageEventId: null,
        createdAt: new Date().toISOString(),
      },
    },
  ]);
  if (result.errors.length > 0) return null;

  const record = await prisma.businessRecord.findUnique({
    where: {
      storeId_entityType_sourceProvider_externalId: {
        storeId: params.storeId,
        entityType: "asset",
        sourceProvider: SOURCE_PROVIDER,
        externalId: params.imageUrl,
      },
    },
    select: { id: true },
  });
  if (!record) return null;

  await designateAsset(params.storeId, record.id, params.role);
  return record.id;
}
