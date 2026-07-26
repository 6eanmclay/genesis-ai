import { prisma } from "@/lib/prisma";
import { PERMISSIONS } from "@/lib/permissions";
import type { Executable } from "../executable";
import { EXECUTION_ACTIONS } from "../actions";

export interface UpdateProductImageInput {
  productId: string;
  imageUrl: string;
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
    const product = await prisma.product.update({
      where: { id: input.productId },
      data: { imageUrl: input.imageUrl },
    });
    return {
      message: `Updated image for "${product.name}"`,
      metadata: { productId: product.id, name: product.name },
    };
  },
};
