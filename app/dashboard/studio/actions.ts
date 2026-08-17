"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { PERMISSIONS, requireStorePageAccess } from "@/lib/permissions";
import { designateAsset, ASSET_ROLES } from "@/lib/businessModel/assets";
import { AssetSchema } from "@/lib/businessModel/entities";

// Designating what the owner just uploaded (2026-08-18).
//
// The upload itself still goes through uploadBusinessAssetFromChat and
// ingestBusinessAsset, unchanged — this is not a second upload path. What it
// adds is the one thing Studio knows that the chat upload does not: the owner
// pressed a button that said "Upload a logo", so the role is not a guess.
//
// WHY THIS IS NEEDED AT ALL. ingestBusinessAsset deliberately records role:
// null, because an upload arriving through chat has nobody saying what it is
// for and guessing from a filename would be fabrication. In Studio the owner
// has already said. Without this step an uploaded logo stays undesignated,
// resolveCurrentAsset("brand.logo") does not find it, and "put my logo on a
// hoodie" reaches for a logo the owner just provided and misses it.
//
// Roles are a closed map. A role arriving from the client unchecked would let
// anything write anything into the designation system.
const STUDIO_ROLES: Record<string, string> = {
  logo: ASSET_ROLES.brandLogo,
  product: ASSET_ROLES.productPhoto,
  lifestyle: "brand.lifestyle",
  social: "brand.social",
};

export async function designateUploadedAsset(
  storageUrl: string,
  roleKey: string
): Promise<{ ok: boolean; role?: string }> {
  const { store } = await requireStorePageAccess(PERMISSIONS.STORE_MANAGE);
  const role = STUDIO_ROLES[roleKey];
  if (!role) return { ok: false };

  // Found by URL rather than by "most recent", because several files can be
  // uploaded in one go and the newest row is not necessarily the one this call
  // is about.
  const rows = await prisma.businessRecord.findMany({
    where: { storeId: store.id, entityType: "asset" },
    orderBy: { syncedAt: "desc" },
    take: 50,
    select: { id: true, data: true },
  });
  const match = rows.find((r) => {
    const parsed = AssetSchema.safeParse(r.data);
    return parsed.success && parsed.data.storageUrl === storageUrl;
  });
  if (!match) return { ok: false };

  await designateAsset(store.id, match.id, role);
  // The bench shows what J4 can use, so it has to reflect this immediately.
  revalidatePath("/dashboard/studio");
  return { ok: true, role };
}
