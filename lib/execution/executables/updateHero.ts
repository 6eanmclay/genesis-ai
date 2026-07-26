import { prisma } from "@/lib/prisma";
import { PERMISSIONS } from "@/lib/permissions";
import type { Executable } from "../executable";
import { EXECUTION_ACTIONS } from "../actions";

export interface UpdateHeroInput {
  heroHeadline: string;
  heroSubheadline: string;
}

// Same opaque-JSON pattern as updateSeo.ts, targeting a different section
// of the same blueprint — deliberately structured as the twin of that file
// to prove the registry pattern generalizes with zero special-casing.
interface BlueprintShape {
  homepageContent?: Record<string, unknown>;
  [key: string]: unknown;
}

export const updateHeroExecutable: Executable<UpdateHeroInput, Record<string, never>> = {
  action: EXECUTION_ACTIONS.STORE_UPDATE_HERO,
  requiredPermission: PERMISSIONS.STORE_MANAGE,
  async run(input, ctx) {
    const store = await prisma.store.findUniqueOrThrow({
      where: { id: ctx.storeId },
      select: { blueprint: true },
    });
    const blueprint = (store.blueprint as BlueprintShape | null) ?? {};
    const updatedBlueprint: BlueprintShape = {
      ...blueprint,
      homepageContent: {
        ...blueprint.homepageContent,
        heroHeadline: input.heroHeadline,
        heroSubheadline: input.heroSubheadline,
      },
    };
    await prisma.store.update({
      where: { id: ctx.storeId },
      data: { blueprint: updatedBlueprint as object },
    });
    return { message: "Updated homepage hero headline and subheadline" };
  },
};
