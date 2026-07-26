import { prisma } from "@/lib/prisma";
import { PERMISSIONS } from "@/lib/permissions";
import type { Executable } from "../executable";
import { EXECUTION_ACTIONS } from "../actions";

export interface UpdateStoreIdentityInput {
  name: string;
  tagline: string;
  description: string;
}

export const updateStoreIdentityExecutable: Executable<UpdateStoreIdentityInput, Record<string, never>> = {
  action: EXECUTION_ACTIONS.STORE_UPDATE_STORE_IDENTITY,
  requiredPermission: PERMISSIONS.STORE_MANAGE,
  async run(input, ctx) {
    await prisma.store.update({
      where: { id: ctx.storeId },
      data: { name: input.name, tagline: input.tagline, description: input.description },
    });
    return { message: "Updated store name, tagline, and description" };
  },
};
