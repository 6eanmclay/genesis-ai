import { prisma } from "@/lib/prisma";
import { persistSyncedRecords } from "@/lib/businessModel/sync";
import { AssetSchema, type Asset } from "@/lib/businessModel/entities";

// The asset designation layer (2026-08-16).
//
// The gap this closes, stated plainly: a logo J4 generated was a URL on
// Store.logoUrl, and a photo the owner uploaded was a row with no notion of
// what it was for. Neither was a thing "that logo" could resolve to. Every
// later step of Asset -> Design -> Product -> Provider depends on the first
// word in that chain being a real, referenceable object, so this is the
// foundation rather than a convenience.
//
// DELIBERATELY NOT LOGO-SPECIFIC. Roles are open strings and the functions
// below never mention a particular one — brand logos, product artwork,
// photos, documents and whatever the Studio invents later all use this same
// path. Sean: "I want a general asset system."
//
// No Prisma migration. BusinessRecord is already generic (entityType + JSON
// data) and its own comment says adding an entity type is "a new entry here,
// nothing else" — designation is the same kind of change one level down, so
// this is a Zod change plus this module, and existing asset rows keep
// parsing because every new field defaults to null.

/** Written by Genesis itself rather than pulled from a connector. */
export const GENERATED_SOURCE_PROVIDER = "genesis_generated";

// Common roles, documented rather than enforced — the same reason entities.ts
// uses z.string() over z.enum() for every categorical field. A new role is a
// new string at a call site, never a migration.
export const ASSET_ROLES = {
  brandLogo: "brand.logo",
  brandMark: "brand.mark",
  productArtwork: "product.artwork",
  productPhoto: "product.photo",
} as const;

export interface DesignatedAsset {
  /** The BusinessRecord id — this is what other records point at. */
  id: string;
  role: string | null;
  url: string;
  originalFilename: string;
  summary: string | null;
  origin: string | null;
  generationPrompt: string | null;
  createdAt: string | null;
}

function toDesignatedAsset(row: { id: string; data: unknown }): DesignatedAsset | null {
  const parsed = AssetSchema.safeParse(row.data);
  if (!parsed.success) return null;
  const a = parsed.data;
  return {
    id: row.id,
    role: a.role,
    url: a.storageUrl,
    originalFilename: a.originalFilename,
    summary: a.summary,
    origin: a.origin,
    generationPrompt: a.generationPrompt,
    createdAt: a.createdAt,
  };
}

/**
 * The asset currently holding a role — "the current brand logo".
 *
 * Held-and-not-superseded, not merely newest. Those coincide today, and stop
 * coinciding the moment anything writes history out of order (a backfill, an
 * import, a restored asset). Asking the real question costs nothing now and
 * does not need revisiting then.
 */
export async function resolveCurrentAsset(storeId: string, role: string): Promise<DesignatedAsset | null> {
  const rows = await prisma.businessRecord.findMany({
    where: { storeId, entityType: "asset" },
    orderBy: { syncedAt: "desc" },
    select: { id: true, data: true },
  });

  for (const row of rows) {
    const parsed = AssetSchema.safeParse(row.data);
    if (!parsed.success) continue;
    if (parsed.data.role !== role) continue;
    if (parsed.data.supersededByAssetId) continue;
    return toDesignatedAsset(row);
  }
  return null;
}

/** Every asset holding a role, newest first, superseded ones included. */
export async function listAssetsByRole(storeId: string, role: string): Promise<DesignatedAsset[]> {
  const rows = await prisma.businessRecord.findMany({
    where: { storeId, entityType: "asset" },
    orderBy: { syncedAt: "desc" },
    select: { id: true, data: true },
  });
  return rows
    .filter((r) => AssetSchema.safeParse(r.data).data?.role === role)
    .map(toDesignatedAsset)
    .filter((a): a is DesignatedAsset => a !== null);
}

/** Every role this store currently has an asset for. What J4 can point at. */
export async function currentAssetsByRole(storeId: string): Promise<Record<string, DesignatedAsset>> {
  const rows = await prisma.businessRecord.findMany({
    where: { storeId, entityType: "asset" },
    orderBy: { syncedAt: "desc" },
    select: { id: true, data: true },
  });

  const current: Record<string, DesignatedAsset> = {};
  for (const row of rows) {
    const parsed = AssetSchema.safeParse(row.data);
    if (!parsed.success) continue;
    const { role, supersededByAssetId } = parsed.data;
    if (!role || supersededByAssetId) continue;
    if (current[role]) continue; // newest wins; rows are already desc
    const asset = toDesignatedAsset(row);
    if (asset) current[role] = asset;
  }
  return current;
}

/**
 * Give an existing asset a role, retiring whoever held it before.
 *
 * Separate from recording, because the two genuinely happen apart: an upload
 * arrives with no role and earns one later when classification or the owner
 * says what it is. Superseding is a link in both directions, so history reads
 * forwards and backwards.
 */
export async function designateAsset(storeId: string, recordId: string, role: string): Promise<void> {
  const row = await prisma.businessRecord.findFirst({
    where: { id: recordId, storeId, entityType: "asset" },
    select: { id: true, data: true },
  });
  if (!row) return;
  const parsed = AssetSchema.safeParse(row.data);
  if (!parsed.success) return;

  const previous = await resolveCurrentAsset(storeId, role);
  // Re-designating the asset that already holds the role is a no-op, not a
  // self-supersession — which would otherwise make it its own predecessor and
  // permanently hide it from resolveCurrentAsset.
  if (previous?.id === recordId) return;

  await prisma.businessRecord.update({
    where: { id: row.id },
    data: {
      data: {
        ...parsed.data,
        role,
        supersedesAssetId: previous?.id ?? null,
      } satisfies Asset,
    },
  });

  if (previous) {
    const previousRow = await prisma.businessRecord.findFirst({
      where: { id: previous.id, storeId, entityType: "asset" },
      select: { data: true },
    });
    const previousParsed = previousRow ? AssetSchema.safeParse(previousRow.data) : null;
    if (previousParsed?.success) {
      await prisma.businessRecord.update({
        where: { id: previous.id },
        data: { data: { ...previousParsed.data, supersededByAssetId: recordId } satisfies Asset },
      });
    }
  }
}

/**
 * Record an image Genesis generated as a real, designated asset.
 *
 * Goes through persistSyncedRecords like every other write, so a generated
 * asset gets the identical schema validation and upsert-in-place behaviour an
 * uploaded one does. externalId is the URL, matching the upload path: the same
 * image recorded twice updates one row instead of growing duplicates.
 */
export async function recordGeneratedAsset(params: {
  storeId: string;
  url: string;
  role: string;
  fileType?: "photo" | "document" | "video";
  category?: string;
  summary?: string | null;
  generationPrompt?: string | null;
  aiUsageEventId?: string | null;
  originalFilename?: string;
}): Promise<string | null> {
  const data: Asset = {
    fileType: params.fileType ?? "photo",
    category: params.category ?? params.role,
    storageUrl: params.url,
    originalFilename: params.originalFilename ?? `${params.role.replace(/\./g, "-")}.png`,
    summary: params.summary ?? null,
    extractionConfidence: null,
    relatedRecordId: null,
    relatedEntityType: null,
    role: params.role,
    origin: "generated",
    supersedesAssetId: null,
    supersededByAssetId: null,
    generationPrompt: params.generationPrompt ?? null,
    aiUsageEventId: params.aiUsageEventId ?? null,
    createdAt: new Date().toISOString(),
  };

  const result = await persistSyncedRecords(params.storeId, GENERATED_SOURCE_PROVIDER, [
    { entityType: "asset", externalId: params.url, data },
  ]);
  if (result.errors.length > 0) return null;

  const record = await prisma.businessRecord.findUnique({
    where: {
      storeId_entityType_sourceProvider_externalId: {
        storeId: params.storeId,
        entityType: "asset",
        sourceProvider: GENERATED_SOURCE_PROVIDER,
        externalId: params.url,
      },
    },
    select: { id: true },
  });
  if (!record) return null;

  // Designate after the row exists, so supersession has a real id to point
  // at in both directions.
  await designateAsset(params.storeId, record.id, params.role);
  return record.id;
}
