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
  async run(input) {
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
      where: { id: input.productId },
      data: { imageUrl: input.imageUrl, ...(richContent ? { richContent } : {}) },
    });
    return {
      message: `Updated image for "${product.name}"`,
      metadata: { productId: product.id, name: product.name },
    };
  },
};
