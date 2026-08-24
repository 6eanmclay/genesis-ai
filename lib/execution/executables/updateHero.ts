import { prisma } from "@/lib/prisma";
import { verified, type VerificationOutcome } from "../verification";
import { PERMISSIONS } from "@/lib/permissions";
import type { Executable } from "../executable";
import { EXECUTION_ACTIONS } from "../actions";
import { resolveOwnedImageUrl } from "@/lib/businessModel/assets";
import { writeHomepageContent } from "@/lib/storefront/homepageContent";
import { DEFAULT_THEME, heroLayoutOf, heroLayoutRendersImage, type Theme } from "@/lib/theme";

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
    // AN EXPLICIT REFERENCE TO A REAL ASSET, OR NOTHING (2026-08-21).
    //
    // The input schema is z.string() — it cannot tell a real uploaded photo
    // from a plausible-looking URL a model produced, and neither can verify()
    // below, which only confirms the value round-tripped. Without this check,
    // the failure mode is the worst kind: the owner approves "use my photo",
    // execution reports success, and the storefront shows a broken image
    // pointing at something that never existed.
    //
    // Checked HERE because Execute is the single gateway through which anything
    // real happens (ARCHITECTURE.md) — so chat proposals, recommendation-driven
    // proposals and autonomous ones are all covered by one check rather than
    // three that could drift apart.
    if ("heroImageUrl" in input && input.heroImageUrl) {
      const owned = await resolveOwnedImageUrl(ctx.storeId, input.heroImageUrl);
      if (!owned) {
        // Named plainly, because the honest reading is almost always "that
        // image isn't one of yours" rather than "something broke".
        throw new Error(
          "That image isn't one of this business's own files. A hero image has to be a real uploaded asset or an existing product photo."
        );
      }
    }

    // ONE WRITER. The merge lives in lib/storefront/homepageContent.ts, shared
    // with the design-composition door, so a hero image applied from either
    // place cannot drop the other's headlines.
    const homepageContent = await writeHomepageContent(ctx.storeId, {
      heroHeadline: input.heroHeadline,
      heroSubheadline: input.heroSubheadline,
      // Present only when this proposal actually carried one. `undefined` is
      // dropped by the writer, so "not mentioned" stays distinct from an
      // explicit `null` meaning "clear it".
      heroImageUrl: "heroImageUrl" in input ? input.heroImageUrl : undefined,
    });

    return {
      message:
        "heroImageUrl" in input && input.heroImageUrl
          ? "Updated homepage hero headline, subheadline, and image"
          : "Updated homepage hero headline and subheadline",
      metadata: { heroImageUrl: (homepageContent.heroImageUrl as string | null | undefined) ?? null },
    };
  },
  // Priority 4's own explicit requirement — "The verification step should
  // also confirm that the image actually exists in the resulting
  // storefront... J4 should not report the change as completed if it only
  // changed the text/layout while failing to apply the referenced image"
  // (Sean). Only checks when this proposal actually included an image —
  // a text-only hero edit has nothing image-related to verify.
  async verify(input, ctx) {
    // A text-only hero edit has no image to re-read. That is not the
    // unavailable state — there is nothing this action was asked to persist
    // that could fail to persist, so it is genuinely verified.
    if (!("heroImageUrl" in input) || !input.heroImageUrl) return verified();
    const store = await prisma.store.findUniqueOrThrow({
      where: { id: ctx.storeId },
      select: { blueprint: true, theme: true },
    });
    const blueprint = (store.blueprint as BlueprintShape | null) ?? {};
    const storedUrl = (blueprint.homepageContent as { heroImageUrl?: string | null } | undefined)?.heroImageUrl;
    if (storedUrl !== input.heroImageUrl) {
      return { state: "failed", mismatches: ["heroImageUrl: the hero image was not saved to the storefront"] };
    }

    // SAVED IS NOT SHOWN (2026-08-22), and the difference is the whole point of
    // this step.
    //
    // The check above only proved the value round-tripped. Three of the four
    // hero layouts render no image at all, and the default is one of them — so
    // on an ordinary store this used to save the photo, confirm the save, and
    // report success while the storefront the owner then opened looked exactly
    // as it had before. That is precisely the outcome Sean described: J4 said
    // it would use the photo, said it had, and the site did not have it.
    //
    // Read through the same predicate the storefront renders through, so this
    // cannot pass while the page shows nothing.
    const theme = (store.theme as Theme | null) ?? DEFAULT_THEME;
    if (!heroLayoutRendersImage(heroLayoutOf(theme))) {
      // Named as the real situation rather than a generic failure: the image is
      // genuinely saved and will appear the moment the layout can show one.
      // Silently switching the layout instead would be Genesis redesigning the
      // storefront on the strength of a photo — a bigger change than the owner
      // approved. It is still a failed verification, because the owner asked to
      // see their photo and the storefront does not show it.
      return {
        state: "failed",
        mismatches: ["heroImageUrl: saved, but this hero layout does not display an image"],
      };
    }
    return verified();
  },
};
