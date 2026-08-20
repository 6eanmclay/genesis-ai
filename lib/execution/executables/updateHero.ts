import { prisma } from "@/lib/prisma";
import { PERMISSIONS } from "@/lib/permissions";
import type { Executable } from "../executable";
import { EXECUTION_ACTIONS } from "../actions";

export interface UpdateHeroInput {
  heroHeadline: string;
  heroSubheadline: string;
  // Priority 4 (asset-to-storefront, 2026-08-09) — the real architectural
  // gap this closes: J4 could talk about using an uploaded photo as the
  // hero image, but had no field anywhere in the proposal/execution
  // pipeline to actually carry that reference through. `undefined` means
  // "leave whatever's there untouched" (the field wasn't part of this
  // proposal at all — matches update_product's own optional-field
  // convention); `null` is a real, explicit "clear the hero image, fall
  // back to the gradient." Never guessed/defaulted — only ever set when
  // the proposal genuinely included an image change.
  heroImageUrl?: string | null;
}

// Same opaque-JSON pattern as updateSeo.ts, targeting a different section
// of the same blueprint — deliberately structured as the twin of that file
// to prove the registry pattern generalizes with zero special-casing.
interface BlueprintShape {
  homepageContent?: Record<string, unknown>;
  [key: string]: unknown;
}

export const updateHeroExecutable: Executable<UpdateHeroInput, { heroImageUrl: string | null }> = {
  action: EXECUTION_ACTIONS.STORE_UPDATE_HERO,
  requiredPermission: PERMISSIONS.STORE_MANAGE,
  async run(input, ctx) {
    const store = await prisma.store.findUniqueOrThrow({
      where: { id: ctx.storeId },
      select: { blueprint: true },
    });
    const blueprint = (store.blueprint as BlueprintShape | null) ?? {};
    const currentHomepageContent = (blueprint.homepageContent ?? {}) as Record<string, unknown>;
    const updatedBlueprint: BlueprintShape = {
      ...blueprint,
      homepageContent: {
        ...currentHomepageContent,
        heroHeadline: input.heroHeadline,
        heroSubheadline: input.heroSubheadline,
        // Only touches heroImageUrl when this proposal actually included
        // one — "in" check, not just truthiness, so an explicit `null`
        // (clear the image) is honored and not confused with "field
        // absent."
        ...("heroImageUrl" in input ? { heroImageUrl: input.heroImageUrl } : {}),
      },
    };
    await prisma.store.update({
      where: { id: ctx.storeId },
      data: { blueprint: updatedBlueprint as object },
    });
    return {
      message:
        "heroImageUrl" in input && input.heroImageUrl
          ? "Updated homepage hero headline, subheadline, and image"
          : "Updated homepage hero headline and subheadline",
      metadata: { heroImageUrl: (updatedBlueprint.homepageContent as { heroImageUrl?: string | null }).heroImageUrl ?? null },
    };
  },
  // Priority 4's own explicit requirement — "The verification step should
  // also confirm that the image actually exists in the resulting
  // storefront... J4 should not report the change as completed if it only
  // changed the text/layout while failing to apply the referenced image"
  // (Sean). Only checks when this proposal actually included an image —
  // a text-only hero edit has nothing image-related to verify.
  async verify(input, ctx) {
    if (!("heroImageUrl" in input) || !input.heroImageUrl) return { ok: true };
    const store = await prisma.store.findUniqueOrThrow({
      where: { id: ctx.storeId },
      select: { blueprint: true },
    });
    const blueprint = (store.blueprint as BlueprintShape | null) ?? {};
    const storedUrl = (blueprint.homepageContent as { heroImageUrl?: string | null } | undefined)?.heroImageUrl;
    if (storedUrl !== input.heroImageUrl) {
      return { ok: false, error: "The hero image wasn't actually saved to the storefront." };
    }
    return { ok: true };
  },
};
