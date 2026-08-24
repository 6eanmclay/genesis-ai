import { prisma } from "@/lib/prisma";
import { verifyBlueprintSection } from "../readBack";
import type { VerificationOutcome } from "../verification";
import { PERMISSIONS } from "@/lib/permissions";
import type { Executable } from "../executable";
import { EXECUTION_ACTIONS } from "../actions";

// Deliberately scoped to the scalar homepage fields only — the structured
// fields (sectionOrder, customSection, faq[], featuredCollections,
// newsletterSection) need their own diff presentation before they can be
// approval-gated the same way (see Phase 1 plan); they continue to apply
// directly for now, untouched by this Executable.
export interface UpdateHomepageContentInput {
  primaryCallToAction: string;
  secondaryCallToAction: string | null;
  aboutUs: string;
  whyChooseUs: string;
}

interface BlueprintShape {
  homepageContent?: Record<string, unknown>;
  [key: string]: unknown;
}

export const updateHomepageContentExecutable: Executable<UpdateHomepageContentInput, Record<string, never>> = {
  action: EXECUTION_ACTIONS.STORE_UPDATE_HOMEPAGE_CONTENT,
  requiredPermission: PERMISSIONS.STORE_MANAGE,
  async run(input, ctx) {
    const store = await prisma.store.findUniqueOrThrow({
      where: { id: ctx.storeId },
      select: { blueprint: true },
    });
    const blueprint = (store.blueprint as BlueprintShape | null) ?? {};
    const updatedBlueprint: BlueprintShape = {
      ...blueprint,
      homepageContent: { ...blueprint.homepageContent, ...input },
    };
    await prisma.store.update({
      where: { id: ctx.storeId },
      data: { blueprint: updatedBlueprint as object },
    });
    return { message: "Updated homepage content" };
  },

  // CLASS B — a merge into blueprint.homepageContent. Only the keys this input named
  // are compared: that section holds keys written by other actions too, and
  // comparing the whole of it would fail a merge that did exactly what it
  // promised.
  async verify(input, ctx): Promise<VerificationOutcome> {
    return verifyBlueprintSection(ctx.storeId, "homepageContent", input);
  },
};
