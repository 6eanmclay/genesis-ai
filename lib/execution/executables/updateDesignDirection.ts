import { prisma } from "@/lib/prisma";
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
};
