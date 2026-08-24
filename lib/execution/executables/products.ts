import { prisma } from "@/lib/prisma";
import { verifiedUnless, namedKeyMismatches } from "../verification";
import type { VerificationOutcome } from "../verification";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveProductImage } from "@/lib/imageProviders/resolveProductImage";
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
  //
  // Real mobile bug fix (2026-08-08) — this used to be `uploadedImage:
  // File | null`, uploaded to Blob server-side inside this executable.
  // That meant a real phone photo's bytes had to survive the Server
  // Action's own request body first, hard-capped at Vercel's platform-
  // level 4.5MB Function payload ceiling. The browser now uploads directly
  // to Blob (CreateProductForm.tsx) before this executable ever runs.
  //
  // Product media gallery (2026-08-08) — plural now: the create form
  // supports selecting several images at once, per Sean's explicit "the
  // upload flow must support selecting multiple images at once" and "do
  // not make the 10-image feature dependent on uploading images one at a
  // time." Empty array behaves exactly like the old null case.
  uploadedImageUrls?: string[];
}

// Same logic createProduct always had (position by current count,
// placeholder image via lib/unsplash.ts), now reporting through the engine.
export const createProductExecutable: Executable<CreateProductInput, ProductMetadata> = {
  action: EXECUTION_ACTIONS.PRODUCT_CREATE,
  requiredPermission: PERMISSIONS.PRODUCTS_MANAGE,
  async run(input, ctx) {
    const productCount = await prisma.product.count({ where: { storeId: ctx.storeId } });

    let imageUrls: string[];
    let generationPrompt: string | undefined;
    if (input.uploadedImageUrls && input.uploadedImageUrls.length > 0) {
      imageUrls = input.uploadedImageUrls;
    } else {
      const sourced = await resolveProductImage({
        prompt: input.description || input.name,
        name: input.name,
        description: input.description,
        excludeUrls: [],
        scope: { storeId: ctx.storeId },
        feature: "product_image_generation",
      });
      imageUrls = sourced?.url ? [sourced.url] : [];
      generationPrompt = sourced?.generationPrompt;
    }

    const product = await prisma.product.create({
      data: {
        storeId: ctx.storeId,
        name: input.name,
        description: input.description,
        priceInCents: input.priceInCents,
        position: productCount,
        imageUrl: imageUrls[0] ?? null,
        // Preserves a generated image's prompt the same way
        // updateProductImageExecutable does — see its own comment. Never
        // set for an owner-uploaded photo — there's no prompt behind it.
        ...(generationPrompt ? { richContent: { imagePrompt: generationPrompt } } : {}),
      },
    });
    // Product media gallery (2026-08-08) — every image this product is
    // created with (uploaded or AI-generated) becomes a real ProductImage
    // row too, not just the Product.imageUrl scalar, so a freshly created
    // product participates in the same gallery model a backfilled one
    // does from the start — never a product that only gets a real gallery
    // once someone separately uses the "Add photos" control.
    if (imageUrls.length > 0) {
      await prisma.productImage.createMany({
        data: imageUrls.map((url, i) => ({ productId: product.id, url, position: i })),
      });
    }
    return {
      message: `Added product "${product.name}"`,
      metadata: { productId: product.id, name: product.name, priceInCents: product.priceInCents },
    };
  },

  // CLASS C — the row must now exist, found by the id run() recorded, carrying
  // the values asked for. A create that wrote nothing does not throw.
  async verify(input, ctx, metadata): Promise<VerificationOutcome> {
    const id = metadata?.productId;
    if (!id) return { state: "failed", mismatches: ["the run recorded no product id"] };
    const product = await prisma.product.findFirst({
      where: { id, storeId: ctx.storeId },
      select: { name: true, priceInCents: true, description: true },
    });
    if (!product) return { state: "failed", mismatches: ["product: no such row after the create"] };
    return verifiedUnless(
      namedKeyMismatches(
        { name: input.name, priceInCents: input.priceInCents, description: input.description },
        product as unknown as Record<string, unknown>,
        "product."
      )
    );
  },
};

// J4 approvable product content changes (2026-08-09) — "if J4 can perform
// the change, J4 should perform the change after I approve it... product
// names, descriptions" (Sean). name/description/priceInCents are now
// individually optional (only productId is required) so a real chat-
// driven proposal (request_product_content_change, app/api/chat/route.ts)
// can carry just the field(s) it's actually changing — an owner asking
// J4 to improve a product's name shouldn't force a redundant "Price:
// $19.99 -> $19.99" row into the approval diff. The existing manual edit
// form (EditProductForm.tsx -> editProduct, app/dashboard/actions.ts)
// always sends all three fields — this stays a no-op change for that
// real, already-working call site.
export interface EditProductInput {
  productId: string;
  name?: string;
  description?: string | null;
  priceInCents?: number;
}

export const editProductExecutable: Executable<EditProductInput, ProductMetadata> = {
  action: EXECUTION_ACTIONS.PRODUCT_EDIT,
  requiredPermission: PERMISSIONS.PRODUCTS_MANAGE,
  async run(input, ctx) {
    const data: { name?: string; description?: string | null; priceInCents?: number } = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.description !== undefined) data.description = input.description;
    if (input.priceInCents !== undefined) data.priceInCents = input.priceInCents;

    const product = await prisma.product.update({
      where: { id: input.productId, storeId: ctx.storeId },
      data,
    });
    return {
      message: `Updated product "${product.name}"`,
      metadata: { productId: product.id, name: product.name, priceInCents: product.priceInCents },
    };
  },

  // CLASS B in shape though not in storage — the input names only the fields it
  // is changing, so only those are compared. Comparing the whole row would fail
  // an edit that deliberately left the rest alone.
  async verify(input, ctx): Promise<VerificationOutcome> {
    const product = await prisma.product.findFirst({
      where: { id: input.productId, storeId: ctx.storeId },
      select: { name: true, priceInCents: true, description: true },
    });
    if (!product) return { state: "failed", mismatches: ["product: no such row after the edit"] };
    return verifiedUnless(
      namedKeyMismatches(
        { name: input.name, description: input.description, priceInCents: input.priceInCents },
        product as unknown as Record<string, unknown>,
        "product."
      )
    );
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

  // CLASS D, but the expectation IS derivable from the input: the write is
  // `active: !input.currentActive`, so the caller's own statement of the prior
  // value gives verification something exact to look for.
  async verify(input, ctx): Promise<VerificationOutcome> {
    const product = await prisma.product.findFirst({
      where: { id: input.productId, storeId: ctx.storeId },
      select: { active: true },
    });
    if (!product) return { state: "failed", mismatches: ["product: no such row after the toggle"] };
    const expected = !input.currentActive;
    return product.active === expected
      ? { state: "verified" }
      : { state: "failed", mismatches: [`product.active: expected ${expected}, stored ${product.active}`] };
  },
};

export interface DeleteProductInput {
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

  // CLASS C, the other direction. A delete that matched nothing does not throw
  // — Prisma reports a count — so absence is the thing worth checking.
  async verify(input, ctx): Promise<VerificationOutcome> {
    const still = await prisma.product.findFirst({
      where: { id: input.productId, storeId: ctx.storeId },
      select: { id: true },
    });
    return still
      ? { state: "failed", mismatches: ["product: still present after the delete"] }
      : { state: "verified" };
  },
};
