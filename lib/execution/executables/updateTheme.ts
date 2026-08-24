import { prisma } from "@/lib/prisma";
import { verifyStoreColumns } from "../readBack";
import type { VerificationOutcome } from "../verification";
import { PERMISSIONS } from "@/lib/permissions";
import type { Theme } from "@/lib/theme";
import type { Executable } from "../executable";
import { EXECUTION_ACTIONS } from "../actions";

export type UpdateThemeInput = Theme;

export const updateThemeExecutable: Executable<UpdateThemeInput, Record<string, never>> = {
  action: EXECUTION_ACTIONS.STORE_UPDATE_THEME,
  requiredPermission: PERMISSIONS.STORE_MANAGE,
  async run(input, ctx) {
    await prisma.store.update({
      where: { id: ctx.storeId },
      data: { theme: input as object },
    });
    return { message: "Updated storefront theme" };
  },

  // CLASS A — the input IS the stored value: `data: { theme: input }`. So the
  // read-back is an exact comparison, and there is nothing to interpret.
  async verify(input, ctx): Promise<VerificationOutcome> {
    return verifyStoreColumns(ctx.storeId, { theme: input });
  },
};
