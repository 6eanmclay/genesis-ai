import { prisma } from "@/lib/prisma";
import { PERMISSIONS } from "@/lib/permissions";
import type { Executable } from "../executable";
import { EXECUTION_ACTIONS } from "../actions";

export interface UpdateProductImageInput {
  productId: string;
  imageUrl: string;
  // Set only when imageUrl came from GeneratedImageProvider — the exact
  // prompt actually sent to the generation model, persisted into
  // Product.richContent.imagePrompt so it survives past this one call
  // (see lib/imageProviders/types.ts's own comment on ImageSourceResult).
  // Absent for stock-sourced/uploaded images, which leave richContent
  // untouched.
  generationPrompt?: string;
}

interface ProductMetadata {
  productId: string;
  name: string;
}

// Ordinary Executable — knows nothing about Genesis, approvals, or how
// imageUrl was sourced. Callable via plain execute() from anywhere, same as
// every other product executable in this directory.
export const updateProductImageExecutable: Executable<UpdateProductImageInput, ProductMetadata> = {
  action: EXECUTION_ACTIONS.PRODUCT_UPDATE_IMAGE,
  requiredPermission: PERMISSIONS.PRODUCTS_MANAGE,
  async run(input, ctx) {
    let richContent: object | undefined;
    if (input.generationPrompt) {
      const existing = await prisma.product.findUnique({
        where: { id: input.productId },
        select: { richContent: true },
      });
      const existingRichContent =
        existing?.richContent && typeof existing.richContent === "object" ? existing.richContent : {};
      richContent = { ...existingRichContent, imagePrompt: input.generationPrompt };
    }

    const product = await prisma.product.update({
      where: { id: input.productId, storeId: ctx.storeId },
      data: { imageUrl: input.imageUrl, ...(richContent ? { richContent } : {}) },
    });

    // Product media gallery (2026-08-08) — this executable predates the
    // gallery and only ever wrote Product.imageUrl directly; without this,
    // a chat-approved photo replacement would desync the scalar column
    // from the ProductImage table's own position-0 row (the real source
    // every gallery UI reads from), silently reverting to the old photo
    // the next time anything reads the gallery instead of imageUrl
    // directly. Same real operation as ReplaceProductImageInput's own
    // primary-image case: update the existing position-0 row in place, or
    // create one if this product had no images at all yet.
    const existingPrimary = await prisma.productImage.findFirst({
      where: { productId: input.productId },
      orderBy: { position: "asc" },
    });
    if (existingPrimary) {
      await prisma.productImage.update({ where: { id: existingPrimary.id }, data: { url: input.imageUrl } });
    } else {
      await prisma.productImage.create({ data: { productId: input.productId, url: input.imageUrl, position: 0 } });
    }

    return {
      message: `Updated image for "${product.name}"`,
      metadata: { productId: product.id, name: product.name },
    };
  },
};
