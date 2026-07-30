import { prisma } from "@/lib/prisma";
import { PERMISSIONS } from "@/lib/permissions";
import type { Executable } from "../executable";
import { EXECUTION_ACTIONS } from "../actions";

// Scoped to the non-SEO marketing fields only — seoTitle/seoMetaDescription
// keep flowing through the existing update_seo action, untouched by this one.
export interface UpdateMarketingAssetsInput {
  brandKeywords: string[];
  instagramBio: string;
  facebookDescription: string;
  xBio: string;
}

interface BlueprintShape {
  marketingAssets?: Record<string, unknown>;
  [key: string]: unknown;
}

export const updateMarketingAssetsExecutable: Executable<UpdateMarketingAssetsInput, Record<string, never>> = {
  action: EXECUTION_ACTIONS.STORE_UPDATE_MARKETING_ASSETS,
  requiredPermission: PERMISSIONS.STORE_MANAGE,
  async run(input, ctx) {
    const store = await prisma.store.findUniqueOrThrow({
      where: { id: ctx.storeId },
      select: { blueprint: true },
    });
    const blueprint = (store.blueprint as BlueprintShape | null) ?? {};
    const updatedBlueprint: BlueprintShape = {
      ...blueprint,
      marketingAssets: { ...blueprint.marketingAssets, ...input },
    };
    await prisma.store.update({
      where: { id: ctx.storeId },
      data: { blueprint: updatedBlueprint as object },
    });
    return { message: "Updated marketing assets" };
  },
};
