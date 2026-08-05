import { prisma } from "@/lib/prisma";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveProductImage } from "@/lib/imageProviders/resolveProductImage";
import { uploadProductImageFile } from "@/lib/imageProviders/uploadProvider";
import type { Executable } from "../executable";
import { EXECUTION_ACTIONS } from "../actions";

interface ProductMetadata {
  productId: string;
  name: string;
  priceInCents?: number;
}

export interface CreateProductInput {
  name: string;
  description: string | null;
  priceInCents: number;
  // Beta readiness fix, 2026-08-05 — "AI should assist, not be required"
  // (J4_IDENTITY.md) applied to product creation specifically. When the
  // owner attaches their own photo, it's used directly and
  // resolveProductImage's AI-generation/stock-search chain never runs at
  // all — no paid AI call, no image the owner didn't ask for. Null (the
  // default, unset field) preserves the original behavior exactly.
  uploadedImage?: File | null;
}

// Same logic createProduct always had (position by current count,
// placeholder image via lib/unsplash.ts), now reporting through the engine.
export const createProductExecutable: Executable<CreateProductInput, ProductMetadata> = {
  action: EXECUTION_ACTIONS.PRODUCT_CREATE,
  requiredPermission: PERMISSIONS.PRODUCTS_MANAGE,
  async run(input, ctx) {
    const productCount = await prisma.product.count({ where: { storeId: ctx.storeId } });

    let imageUrl: string | null;
    let generationPrompt: string | undefined;
    if (input.uploadedImage) {
      const uploaded = await uploadProductImageFile(input.uploadedImage);
      imageUrl = uploaded.url;
    } else {
      const sourced = await resolveProductImage({
        prompt: input.description || input.name,
        name: input.name,
        description: input.description,
        excludeUrls: [],
        scope: { storeId: ctx.storeId },
        feature: "product_image_generation",
      });
      imageUrl = sourced?.url ?? null;
      generationPrompt = sourced?.generationPrompt;
    }

    const product = await prisma.product.create({
      data: {
        storeId: ctx.storeId,
        name: input.name,
        description: input.description,
        priceInCents: input.priceInCents,
        position: productCount,
        imageUrl,
        // Preserves a generated image's prompt the same way
        // updateProductImageExecutable does — see its own comment. Never
        // set for an owner-uploaded photo — there's no prompt behind it.
        ...(generationPrompt ? { richContent: { imagePrompt: generationPrompt } } : {}),
      },
    });
    return {
      message: `Added product "${product.name}"`,
      metadata: { productId: product.id, name: product.name, priceInCents: product.priceInCents },
    };
  },
};

interface EditProductInput {
  productId: string;
  name: string;
  description: string | null;
  priceInCents: number;
}

export const editProductExecutable: Executable<EditProductInput, ProductMetadata> = {
  action: EXECUTION_ACTIONS.PRODUCT_EDIT,
  requiredPermission: PERMISSIONS.PRODUCTS_MANAGE,
  async run(input, ctx) {
    const product = await prisma.product.update({
      where: { id: input.productId, storeId: ctx.storeId },
      data: { name: input.name, description: input.description, priceInCents: input.priceInCents },
    });
    return {
      message: `Updated product "${product.name}"`,
      metadata: { productId: product.id, name: product.name, priceInCents: product.priceInCents },
    };
  },
};

interface ToggleActiveInput {
  productId: string;
  currentActive: boolean;
}

// Wrapper already looked up the product (to resolve storeId for the
// permission check) before calling execute(), so its current `active`
// value is passed in rather than re-fetched here.
export const toggleProductActiveExecutable: Executable<ToggleActiveInput, ProductMetadata> = {
  action: EXECUTION_ACTIONS.PRODUCT_TOGGLE_ACTIVE,
  requiredPermission: PERMISSIONS.PRODUCTS_MANAGE,
  async run(input, ctx) {
    const product = await prisma.product.update({
      where: { id: input.productId, storeId: ctx.storeId },
      data: { active: !input.currentActive },
    });
    return {
      message: product.active ? `"${product.name}" is now active` : `"${product.name}" is now hidden`,
      metadata: { productId: product.id, name: product.name },
    };
  },
};

interface DeleteProductInput {
  productId: string;
  name: string;
}

// Wrapper captures the product's name before calling execute(), since it
// won't exist to read once deleted.
export const deleteProductExecutable: Executable<DeleteProductInput, ProductMetadata> = {
  action: EXECUTION_ACTIONS.PRODUCT_DELETE,
  requiredPermission: PERMISSIONS.PRODUCTS_MANAGE,
  async run(input, ctx) {
    await prisma.product.delete({ where: { id: input.productId, storeId: ctx.storeId } });
    return {
      message: `Deleted product "${input.name}"`,
      metadata: { productId: input.productId, name: input.name },
    };
  },
};
