import { prisma } from "@/lib/prisma";
import { verifyBlueprintSection } from "../readBack";
import type { VerificationOutcome } from "../verification";
import { PERMISSIONS } from "@/lib/permissions";
import type { Executable } from "../executable";
import { EXECUTION_ACTIONS } from "../actions";

export interface UpdateStoreContentInput {
  shippingPolicy: string;
  returnPolicy: string;
  privacyPolicy: string;
  termsAndConditions: string;
  contactPageCopy: string;
}

interface BlueprintShape {
  storeContent?: Record<string, unknown>;
  [key: string]: unknown;
}

export const updateStoreContentExecutable: Executable<UpdateStoreContentInput, Record<string, never>> = {
  action: EXECUTION_ACTIONS.STORE_UPDATE_STORE_CONTENT,
  requiredPermission: PERMISSIONS.STORE_MANAGE,
  async run(input, ctx) {
    const store = await prisma.store.findUniqueOrThrow({
      where: { id: ctx.storeId },
      select: { blueprint: true },
    });
    const blueprint = (store.blueprint as BlueprintShape | null) ?? {};
    const updatedBlueprint: BlueprintShape = {
      ...blueprint,
      storeContent: { ...blueprint.storeContent, ...input },
    };
    await prisma.store.update({
      where: { id: ctx.storeId },
      data: { blueprint: updatedBlueprint as object },
    });
    return { message: "Updated store policies" };
  },

  // CLASS B — a merge into blueprint.storeContent. Only the keys this input named
  // are compared: that section holds keys written by other actions too, and
  // comparing the whole of it would fail a merge that did exactly what it
  // promised.
  async verify(input, ctx): Promise<VerificationOutcome> {
    return verifyBlueprintSection(ctx.storeId, "storeContent", input);
  },
};
