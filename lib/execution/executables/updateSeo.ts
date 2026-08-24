import { prisma } from "@/lib/prisma";
import { verifyBlueprintSection } from "../readBack";
import type { VerificationOutcome } from "../verification";
import { PERMISSIONS } from "@/lib/permissions";
import type { Executable } from "../executable";
import { EXECUTION_ACTIONS } from "../actions";

export interface UpdateSeoInput {
  seoTitle: string;
  seoMetaDescription: string;
}

// Store.blueprint is opaque Json — only the two fields this action touches
// are read/written; every other blueprint field passes through untouched
// via the spread. Same opaque-JSON-cast-at-read-site pattern used
// throughout this codebase wherever blueprint is read (see
// lib/dashboard/generateGenesisRecommendations.ts).
interface BlueprintShape {
  marketingAssets?: Record<string, unknown>;
  [key: string]: unknown;
}

// Ordinary Executable — knows nothing about ApprovalRequest, recommendations,
// or Genesis. Callable via plain execute() from anywhere; the approval
// framework (lib/execution/genesisActions.ts) is a caller of this, not a
// variant of it.
export const updateSeoExecutable: Executable<UpdateSeoInput, Record<string, never>> = {
  action: EXECUTION_ACTIONS.STORE_UPDATE_SEO,
  requiredPermission: PERMISSIONS.STORE_MANAGE,
  async run(input, ctx) {
    const store = await prisma.store.findUniqueOrThrow({
      where: { id: ctx.storeId },
      select: { blueprint: true },
    });
    const blueprint = (store.blueprint as BlueprintShape | null) ?? {};
    const updatedBlueprint: BlueprintShape = {
      ...blueprint,
      marketingAssets: {
        ...blueprint.marketingAssets,
        seoTitle: input.seoTitle,
        seoMetaDescription: input.seoMetaDescription,
      },
    };
    await prisma.store.update({
      where: { id: ctx.storeId },
      data: { blueprint: updatedBlueprint as object },
    });
    return { message: "Updated SEO title and meta description" };
  },

  // CLASS B — a merge into blueprint.marketingAssets. Only the keys this input named
  // are compared: that section holds keys written by other actions too, and
  // comparing the whole of it would fail a merge that did exactly what it
  // promised.
  async verify(input, ctx): Promise<VerificationOutcome> {
    return verifyBlueprintSection(ctx.storeId, "marketingAssets", { seoTitle: input.seoTitle, seoMetaDescription: input.seoMetaDescription });
  },
};
