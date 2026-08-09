import { prisma } from "@/lib/prisma";
import { PERMISSIONS } from "@/lib/permissions";
import type { Executable } from "../executable";
import { EXECUTION_ACTIONS } from "../actions";

// Product media gallery (2026-08-08) — up to 10 ordered images per
// product, position 0 always the primary. Product.imageUrl (the original,
// untouched scalar column — see its own schema comment) is kept as a
// denormalized mirror of whichever ProductImage sits at position 0; every
// executable below re-syncs it after any change that could move or remove
// the primary. This is what lets every existing reader of
// Product.imageUrl (storefront, admin list, chat regenerate flow, AI
// generation fallback) keep working completely unchanged.
//
// Tenant isolation note: ProductImage has no storeId column of its own
// (only productId) and is deliberately NOT added to
// lib/tenantIsolation.ts's guarded model list — that guard only
// recognizes a direct scope key or a one-hop `where.store` relation
// filter, neither of which fits a model whose only path to a store is two
// hops away (image -> product -> store). Every query below instead proves
// ownership explicitly, the same "fetch/mutate scoped through the real
// owning relation" discipline every other executable in this directory
// already follows for Product itself (`where: { id, storeId: ctx.storeId }`),
// just one hop further through product.storeId.
const MAX_IMAGES_PER_PRODUCT = 10;

interface ProductImageMetadata {
  productId: string;
  imageCount: number;
}

// storeId required, not just productId — lib/tenantIsolation.ts's guard
// requires every Product.update's own where clause to carry a real
// storeId (or nested store relation), regardless of how well-scoped the
// caller's own earlier lookups already were. Caught by real execution
// (scripts/verify-product-image-gallery-e2e.ts), not by typecheck/lint/
// build — the guard is a runtime Prisma extension, invisible to any of
// those static checks.
async function syncPrimaryImageUrl(productId: string, storeId: string): Promise<void> {
  const primary = await prisma.productImage.findFirst({
    where: { productId },
    orderBy: { position: "asc" },
  });
  await prisma.product.update({
    where: { id: productId, storeId },
    data: { imageUrl: primary?.url ?? null },
  });
}

export interface AddProductImagesInput {
  productId: string;
  // Already uploaded (direct-to-Blob, client-side) — this executable only
  // ever persists real, already-final URLs, never bytes. Order here is
  // the order they'll be appended in.
  urls: string[];
}

export const addProductImagesExecutable: Executable<AddProductImagesInput, ProductImageMetadata> = {
  action: EXECUTION_ACTIONS.PRODUCT_ADD_IMAGES,
  requiredPermission: PERMISSIONS.PRODUCTS_MANAGE,
  async run(input, ctx) {
    const product = await prisma.product.findFirst({
      where: { id: input.productId, storeId: ctx.storeId },
      select: { id: true, name: true },
    });
    if (!product) {
      throw new Error("Product not found");
    }
    if (input.urls.length === 0) {
      throw new Error("No images to add");
    }

    const existingCount = await prisma.productImage.count({ where: { productId: product.id } });
    if (existingCount + input.urls.length > MAX_IMAGES_PER_PRODUCT) {
      throw new Error(
        `A product can have up to ${MAX_IMAGES_PER_PRODUCT} images — this product already has ${existingCount}, ` +
          `so only ${Math.max(0, MAX_IMAGES_PER_PRODUCT - existingCount)} more can be added.`
      );
    }

    await prisma.productImage.createMany({
      data: input.urls.map((url, i) => ({ productId: product.id, url, position: existingCount + i })),
    });

    // Only the very first image(s) on a previously-empty product actually
    // change the primary — appending to an existing gallery never moves
    // position 0.
    if (existingCount === 0) {
      await syncPrimaryImageUrl(product.id, ctx.storeId);
    }

    const imageCount = existingCount + input.urls.length;
    return {
      message: `Added ${input.urls.length} image${input.urls.length === 1 ? "" : "s"} to "${product.name}"`,
      metadata: { productId: product.id, imageCount },
    };
  },
};

export interface ReorderProductImagesInput {
  productId: string;
  // The complete, new ordering — must be exactly the set of image ids
  // already belonging to this product, verified below rather than trusted.
  // Moving an image to index 0 IS "making it primary" — one real
  // mechanism, not two.
  orderedImageIds: string[];
}

export const reorderProductImagesExecutable: Executable<ReorderProductImagesInput, ProductImageMetadata> = {
  action: EXECUTION_ACTIONS.PRODUCT_REORDER_IMAGES,
  requiredPermission: PERMISSIONS.PRODUCTS_MANAGE,
  async run(input, ctx) {
    const product = await prisma.product.findFirst({
      where: { id: input.productId, storeId: ctx.storeId },
      select: { id: true, name: true },
    });
    if (!product) {
      throw new Error("Product not found");
    }

    const existing = await prisma.productImage.findMany({ where: { productId: product.id } });
    const existingIds = new Set(existing.map((img) => img.id));
    const requestedIds = new Set(input.orderedImageIds);
    if (existingIds.size !== requestedIds.size || [...existingIds].some((id) => !requestedIds.has(id))) {
      throw new Error("That reorder doesn't match this product's real images — please refresh and try again.");
    }

    await Promise.all(
      input.orderedImageIds.map((id, position) => prisma.productImage.update({ where: { id }, data: { position } }))
    );
    await syncPrimaryImageUrl(product.id, ctx.storeId);

    return {
      message: `Reordered images for "${product.name}"`,
      metadata: { productId: product.id, imageCount: existing.length },
    };
  },
};

export interface DeleteProductImageInput {
  imageId: string;
}

export const deleteProductImageExecutable: Executable<DeleteProductImageInput, ProductImageMetadata> = {
  action: EXECUTION_ACTIONS.PRODUCT_DELETE_IMAGE,
  requiredPermission: PERMISSIONS.PRODUCTS_MANAGE,
  async run(input, ctx) {
    const image = await prisma.productImage.findFirst({
      where: { id: input.imageId, product: { storeId: ctx.storeId } },
      include: { product: { select: { id: true, name: true } } },
    });
    if (!image) {
      throw new Error("Image not found");
    }

    await prisma.productImage.delete({ where: { id: image.id } });

    // Compact remaining positions (0..n-1) — deleting from the middle
    // must not leave a gap a future add/reorder could land on top of.
    const remaining = await prisma.productImage.findMany({
      where: { productId: image.productId },
      orderBy: { position: "asc" },
    });
    await Promise.all(remaining.map((img, position) => prisma.productImage.update({ where: { id: img.id }, data: { position } })));
    await syncPrimaryImageUrl(image.productId, ctx.storeId);

    return {
      message: `Removed an image from "${image.product.name}"`,
      metadata: { productId: image.productId, imageCount: remaining.length },
    };
  },
};

export interface ReplaceProductImageInput {
  imageId: string;
  // Already uploaded (direct-to-Blob, client-side) — same real convention
  // as AddProductImagesInput.urls.
  url: string;
}

export const replaceProductImageExecutable: Executable<ReplaceProductImageInput, ProductImageMetadata> = {
  action: EXECUTION_ACTIONS.PRODUCT_REPLACE_IMAGE,
  requiredPermission: PERMISSIONS.PRODUCTS_MANAGE,
  async run(input, ctx) {
    const image = await prisma.productImage.findFirst({
      where: { id: input.imageId, product: { storeId: ctx.storeId } },
      include: { product: { select: { id: true, name: true } } },
    });
    if (!image) {
      throw new Error("Image not found");
    }

    await prisma.productImage.update({ where: { id: image.id }, data: { url: input.url } });
    if (image.position === 0) {
      await syncPrimaryImageUrl(image.productId, ctx.storeId);
    }

    const imageCount = await prisma.productImage.count({ where: { productId: image.productId } });
    return {
      message: `Replaced an image on "${image.product.name}"`,
      metadata: { productId: image.productId, imageCount },
    };
  },
};
