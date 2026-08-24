import { prisma } from "@/lib/prisma";
import { verifyBlueprintSection } from "../readBack";
import type { VerificationOutcome } from "../verification";
import { PERMISSIONS } from "@/lib/permissions";
import type { Executable } from "../executable";
import { EXECUTION_ACTIONS } from "../actions";

export interface UpdateBrandIdentityInput {
  brandStory: string;
  missionStatement: string;
  visionStatement: string;
  brandPromise: string;
  coreValues: string[];
  brandPersonality: string;
  brandVoiceAndTone: string;
  targetAudience: string;
  uniqueSellingProposition: string;
}

// Twin of updateHero.ts/updateSeo.ts — same opaque-JSON blueprint merge
// pattern, targeting brandIdentity instead of homepageContent/marketingAssets.
interface BlueprintShape {
  brandIdentity?: Record<string, unknown>;
  [key: string]: unknown;
}

export const updateBrandIdentityExecutable: Executable<UpdateBrandIdentityInput, Record<string, never>> = {
  action: EXECUTION_ACTIONS.STORE_UPDATE_BRAND_IDENTITY,
  requiredPermission: PERMISSIONS.STORE_MANAGE,
  async run(input, ctx) {
    const store = await prisma.store.findUniqueOrThrow({
      where: { id: ctx.storeId },
      select: { blueprint: true },
    });
    const blueprint = (store.blueprint as BlueprintShape | null) ?? {};
    const updatedBlueprint: BlueprintShape = {
      ...blueprint,
      brandIdentity: { ...blueprint.brandIdentity, ...input },
    };
    await prisma.store.update({
      where: { id: ctx.storeId },
      data: { blueprint: updatedBlueprint as object },
    });
    return { message: "Updated brand identity" };
  },

  // CLASS B — a merge into blueprint.brandIdentity. Only the keys this input named
  // are compared: that section holds keys written by other actions too, and
  // comparing the whole of it would fail a merge that did exactly what it
  // promised.
  async verify(input, ctx): Promise<VerificationOutcome> {
    return verifyBlueprintSection(ctx.storeId, "brandIdentity", input);
  },
};
