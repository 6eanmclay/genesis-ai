import { prisma } from "@/lib/prisma";
import { PERMISSIONS } from "@/lib/permissions";
import type { Executable } from "../executable";
import { EXECUTION_ACTIONS } from "../actions";

interface PublishMetadata {
  published: boolean;
}

// Toggles Store.published — the same logic toggleStorePublished always had,
// now reporting through the engine instead of a bare redirect.
export const publishStoreExecutable: Executable<void, PublishMetadata> = {
  action: EXECUTION_ACTIONS.STORE_PUBLISH,
  requiredPermission: PERMISSIONS.STORE_MANAGE,
  async run(_input, ctx) {
    const store = await prisma.store.findUniqueOrThrow({ where: { id: ctx.storeId } });
    const updated = await prisma.store.update({
      where: { id: ctx.storeId },
      data: { published: !store.published },
    });
    return {
      message: updated.published ? "Store published" : "Store unpublished",
      metadata: { published: updated.published },
    };
  },
};
