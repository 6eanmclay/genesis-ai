import { prisma } from "@/lib/prisma";
import { PERMISSIONS } from "@/lib/permissions";
import { ASSET_ROLES, recordGeneratedAsset } from "@/lib/businessModel/assets";
import type { Executable } from "../executable";
import { EXECUTION_ACTIONS } from "../actions";

export interface UpdateBrandLogoInput {
  imageUrl: string;
  /** The exact prompt sent to the image model, kept as provenance. */
  generationPrompt?: string;
  /** Set when the image came from GeneratedImageProvider. */
  aiUsageEventId?: string;
}

interface BrandLogoMetadata {
  imageUrl: string;
  assetId: string | null;
}

// Approving a logo does two things, and the second is the point (2026-08-16).
//
// Store.logoUrl keeps the existing render path working exactly as it did — no
// caller of it changes, nothing has to know about assets to show a logo. The
// designated Asset is what makes the logo a REFERENCEABLE object: something
// "put that logo on a T-shirt" can resolve, something with a role, a history
// and a supersession chain. One without the other is either an invisible
// asset or an unusable URL.
//
// recordGeneratedAsset designates as it records, so a new approved logo takes
// the brand.logo role and the previous holder points forward rather than being
// deleted — "what did the logo look like before" keeps an answer.
//
// Asset failure is non-fatal and deliberately so: the owner approved a logo,
// and they must get their logo. A failure here costs the ability to refer to
// it by role until something records it again, which is recoverable; refusing
// the approval outright is not.
export const updateBrandLogoExecutable: Executable<UpdateBrandLogoInput, BrandLogoMetadata> = {
  action: EXECUTION_ACTIONS.STORE_UPDATE_BRAND_LOGO,
  requiredPermission: PERMISSIONS.STORE_MANAGE,
  async run(input, ctx) {
    const store = await prisma.store.update({
      where: { id: ctx.storeId },
      data: { logoUrl: input.imageUrl },
      select: { id: true, name: true },
    });

    let assetId: string | null = null;
    try {
      assetId = await recordGeneratedAsset({
        storeId: ctx.storeId,
        url: input.imageUrl,
        role: ASSET_ROLES.brandLogo,
        category: "brand_logo",
        summary: `Brand logo for ${store.name}`,
        originalFilename: "brand-logo.png",
        generationPrompt: input.generationPrompt ?? null,
        aiUsageEventId: input.aiUsageEventId ?? null,
      });
    } catch {
      // See the note above. The logo is live either way.
    }

    return {
      message: `Updated the brand logo for "${store.name}"`,
      metadata: { imageUrl: input.imageUrl, assetId },
    };
  },
};
