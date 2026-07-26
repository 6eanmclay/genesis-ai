import { prisma } from "@/lib/prisma";
import { PERMISSIONS } from "@/lib/permissions";
import type { Executable } from "../executable";
import { EXECUTION_ACTIONS } from "../actions";

interface StoreEditInput {
  name: string;
  description: string | null;
}

interface StoreEditMetadata {
  name: string;
  descriptionChanged: boolean;
}

// Updates Store.name/description — the same logic editStore always had, now
// reporting through the engine instead of a bare redirect.
export const editStoreExecutable: Executable<StoreEditInput, StoreEditMetadata> = {
  action: EXECUTION_ACTIONS.STORE_EDIT,
  requiredPermission: PERMISSIONS.STORE_MANAGE,
  async run(input, ctx) {
    const before = await prisma.store.findUniqueOrThrow({
      where: { id: ctx.storeId },
      select: { description: true },
    });
    await prisma.store.update({
      where: { id: ctx.storeId },
      data: { name: input.name, description: input.description },
    });
    return {
      message: "Store info updated",
      metadata: {
        name: input.name,
        descriptionChanged: before.description !== input.description,
      },
    };
  },
};
