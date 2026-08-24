import { prisma } from "@/lib/prisma";
import { verifyBlueprintSection } from "../readBack";
import type { VerificationOutcome } from "../verification";
import { PERMISSIONS } from "@/lib/permissions";
import type { Executable } from "../executable";
import { EXECUTION_ACTIONS } from "../actions";

export interface UpdateDesignDirectionInput {
  visualStyle: string;
  brandMood: string;
  photographyStyle: string;
  iconStyle: string;
}

interface BlueprintShape {
  designDirection?: Record<string, unknown>;
  [key: string]: unknown;
}

export const updateDesignDirectionExecutable: Executable<UpdateDesignDirectionInput, Record<string, never>> = {
  action: EXECUTION_ACTIONS.STORE_UPDATE_DESIGN_DIRECTION,
  requiredPermission: PERMISSIONS.STORE_MANAGE,
  async run(input, ctx) {
    const store = await prisma.store.findUniqueOrThrow({
      where: { id: ctx.storeId },
      select: { blueprint: true },
    });
    const blueprint = (store.blueprint as BlueprintShape | null) ?? {};
    const updatedBlueprint: BlueprintShape = {
      ...blueprint,
      designDirection: { ...blueprint.designDirection, ...input },
    };
    await prisma.store.update({
      where: { id: ctx.storeId },
      data: { blueprint: updatedBlueprint as object },
    });
    return { message: "Updated design direction" };
  },

  // CLASS B — a merge into blueprint.designDirection. Only the keys this input named
  // are compared: that section holds keys written by other actions too, and
  // comparing the whole of it would fail a merge that did exactly what it
  // promised.
  async verify(input, ctx): Promise<VerificationOutcome> {
    return verifyBlueprintSection(ctx.storeId, "designDirection", input);
  },
};
