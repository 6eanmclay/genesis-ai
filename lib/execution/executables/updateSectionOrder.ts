import { prisma } from "@/lib/prisma";
import { verifyBlueprintSection } from "../readBack";
import type { VerificationOutcome } from "../verification";
import { PERMISSIONS } from "@/lib/permissions";
import type { SectionKey } from "@/lib/storefrontSections";
import type { Executable } from "../executable";
import { EXECUTION_ACTIONS } from "../actions";

export interface UpdateSectionOrderInput {
  sectionOrder: SectionKey[];
}

// Genesis's first structural Website action — otherwise the same one-line
// merge shape as every other content Executable (updateHomepageContent,
// updateHero, etc.). The structural part is entirely in what gets proposed
// and previewed (see the storefront's previewOrder mechanism and the
// Website page's stacked real-preview card) — the write itself is exactly
// as simple as any scalar field update.
interface BlueprintShape {
  homepageContent?: Record<string, unknown>;
  [key: string]: unknown;
}

export const updateSectionOrderExecutable: Executable<UpdateSectionOrderInput, Record<string, never>> = {
  action: EXECUTION_ACTIONS.STORE_UPDATE_SECTION_ORDER,
  requiredPermission: PERMISSIONS.STORE_MANAGE,
  async run(input, ctx) {
    const store = await prisma.store.findUniqueOrThrow({
      where: { id: ctx.storeId },
      select: { blueprint: true },
    });
    const blueprint = (store.blueprint as BlueprintShape | null) ?? {};
    const updatedBlueprint: BlueprintShape = {
      ...blueprint,
      homepageContent: { ...blueprint.homepageContent, sectionOrder: input.sectionOrder },
    };
    await prisma.store.update({
      where: { id: ctx.storeId },
      data: { blueprint: updatedBlueprint as object },
    });
    return { message: "Updated homepage section order" };
  },

  // CLASS B — a merge into blueprint.homepageContent. Only the keys this input named
  // are compared: that section holds keys written by other actions too, and
  // comparing the whole of it would fail a merge that did exactly what it
  // promised.
  async verify(input, ctx): Promise<VerificationOutcome> {
    return verifyBlueprintSection(ctx.storeId, "homepageContent", { sectionOrder: input.sectionOrder });
  },
};
