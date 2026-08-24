import { prisma } from "@/lib/prisma";
import { verifyStoreColumns } from "../readBack";
import type { VerificationOutcome } from "../verification";
import { PERMISSIONS } from "@/lib/permissions";
import type { Executable } from "../executable";
import { EXECUTION_ACTIONS } from "../actions";

interface StoreEditInput {
  name: string;
  tagline: string | null;
  description: string | null;
}

interface StoreEditMetadata {
  name: string;
  descriptionChanged: boolean;
}

// Updates Store.name/tagline/description — the same logic editStore always
// had, now reporting through the engine instead of a bare redirect. Tagline
// added 2026-08-06 (real mobile beta feedback: it rendered display-only
// while name/description were already editable, with no real reason for
// the asymmetry).
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
      data: { name: input.name, tagline: input.tagline, description: input.description },
    });
    return {
      message: "Store info updated",
      metadata: {
        name: input.name,
        descriptionChanged: before.description !== input.description,
      },
    };
  },

  // CLASS A — three columns, written straight from the input.
  async verify(input, ctx): Promise<VerificationOutcome> {
    return verifyStoreColumns(ctx.storeId, {
      name: input.name,
      tagline: input.tagline,
      description: input.description,
    });
  },
};
