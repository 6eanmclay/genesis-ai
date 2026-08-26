import { prisma } from "@/lib/prisma";
import { verifiedUnless, namedKeyMismatches } from "../verification";
import type { VerificationOutcome } from "../verification";
import { PERMISSIONS } from "@/lib/permissions";
import type { Executable } from "../executable";
import { EXECUTION_ACTIONS } from "../actions";
import { normalizeCode } from "@/lib/promotions/eligibility";
import type { DiscountType } from "@/lib/pricing/orderPricing";

// THE MERCHANT'S OWN OFFERS.
//
// Promotions are a pricing decision about products, so they run under
// PRODUCTS_MANAGE rather than a permission of their own — an employee trusted
// to set a price is trusted to discount it, and inventing a second permission
// would have meant every existing role needing to be granted it before a single
// sale could be created.

interface PromotionMetadata {
  promotionId: string;
  name: string;
  kind: "SALE" | "CODE";
}

export interface CreatePromotionInput {
  name: string;
  kind: "SALE" | "CODE";
  /** Required for a CODE, ignored for a SALE. Normalised before it is stored. */
  code?: string | null;
  discountType: DiscountType;
  percentOff?: number | null;
  amountOffInCents?: number | null;
  scope: "ALL_PRODUCTS" | "SELECTED_PRODUCTS";
  /** Only for SELECTED_PRODUCTS. Scoped to this store before it is written. */
  productIds?: string[];
  active?: boolean;
  startsAt?: Date | null;
  endsAt?: Date | null;
}

/**
 * Which of the named products this store actually owns.
 *
 * A promotion may only ever cover products belonging to the store creating it.
 * The ids arrive from a form, and a form is a public POST target — so they are
 * filtered against the store rather than trusted, the same way the PayPal
 * return route scopes the product it looks up.
 */
async function ownedProductIds(storeId: string, productIds: string[]): Promise<string[]> {
  if (productIds.length === 0) return [];
  const rows = await prisma.product.findMany({
    where: { id: { in: productIds }, storeId },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

export const createPromotionExecutable: Executable<CreatePromotionInput, PromotionMetadata> = {
  action: EXECUTION_ACTIONS.PROMOTION_CREATE,
  requiredPermission: PERMISSIONS.PRODUCTS_MANAGE,

  async run(input, ctx) {
    const covered =
      input.scope === "SELECTED_PRODUCTS" ? await ownedProductIds(ctx.storeId, input.productIds ?? []) : [];

    const promotion = await prisma.promotion.create({
      data: {
        storeId: ctx.storeId,
        name: input.name,
        kind: input.kind,
        // A SALE never carries a code — the database enforces this too, so a
        // stray value here would fail loudly rather than create a code nobody
        // is told to type.
        code: input.kind === "CODE" && input.code ? normalizeCode(input.code) : null,
        discountType: input.discountType,
        // Exactly one of these, matching the CHECK constraint. Passing both
        // would be rejected by Postgres, which is the intent: a promotion that
        // cannot say how much it takes off is broken, not generous.
        percentOff: input.discountType === "PERCENTAGE" ? (input.percentOff ?? null) : null,
        amountOffInCents: input.discountType === "FIXED_AMOUNT" ? (input.amountOffInCents ?? null) : null,
        scope: input.scope,
        active: input.active ?? true,
        startsAt: input.startsAt ?? null,
        endsAt: input.endsAt ?? null,
        products: covered.length > 0 ? { create: covered.map((productId) => ({ productId })) } : undefined,
      },
      select: { id: true, name: true, kind: true },
    });

    return {
      message: `Created ${promotion.kind === "CODE" ? "discount code" : "sale"} "${promotion.name}"`,
      metadata: { promotionId: promotion.id, name: promotion.name, kind: promotion.kind },
    };
  },

  // CLASS A — the row is read back whole, including the product links, because
  // a promotion that saved without its products would silently be a store-wide
  // sale rather than a selective one, and would be discovered by a merchant
  // reading a settlement report.
  async verify(input, ctx, metadata): Promise<VerificationOutcome> {
    const promotionId = metadata?.promotionId;
    if (!promotionId) return { state: "failed", mismatches: ["promotion: run() returned no id"] };

    const promotion = await prisma.promotion.findFirst({
      where: { id: promotionId, storeId: ctx.storeId },
      select: {
        name: true, kind: true, code: true, discountType: true,
        percentOff: true, amountOffInCents: true, scope: true, active: true,
        products: { select: { productId: true } },
      },
    });
    if (!promotion) return { state: "failed", mismatches: ["promotion: no such row after the create"] };

    const mismatches = namedKeyMismatches(
      {
        name: input.name,
        kind: input.kind,
        code: input.kind === "CODE" && input.code ? normalizeCode(input.code) : null,
        discountType: input.discountType,
        percentOff: input.discountType === "PERCENTAGE" ? (input.percentOff ?? null) : null,
        amountOffInCents: input.discountType === "FIXED_AMOUNT" ? (input.amountOffInCents ?? null) : null,
        scope: input.scope,
        active: input.active ?? true,
      },
      promotion as unknown as Record<string, unknown>,
      "promotion."
    );

    // Counted, not merely present. Asserting that SOME products were linked
    // would pass on a promotion that saved one of five.
    if (input.scope === "SELECTED_PRODUCTS") {
      const expected = await ownedProductIds(ctx.storeId, input.productIds ?? []);
      const stored = promotion.products.map((p) => p.productId).sort();
      if (stored.join(",") !== [...expected].sort().join(",")) {
        mismatches.push(
          `promotion.products: expected ${expected.length} product(s), stored ${stored.length}`
        );
      }
    }

    return verifiedUnless(mismatches);
  },
};

export interface UpdatePromotionInput {
  promotionId: string;
  name?: string;
  active?: boolean;
  percentOff?: number | null;
  amountOffInCents?: number | null;
  startsAt?: Date | null;
  endsAt?: Date | null;
  /** Replaces the covered set outright when given. Only for SELECTED_PRODUCTS. */
  productIds?: string[];
}

/** The fields an update may touch, named once so run() and verify() cannot drift. */
const UPDATABLE = ["name", "active", "percentOff", "amountOffInCents", "startsAt", "endsAt"] as const;

export const updatePromotionExecutable: Executable<UpdatePromotionInput, PromotionMetadata> = {
  action: EXECUTION_ACTIONS.PROMOTION_UPDATE,
  requiredPermission: PERMISSIONS.PRODUCTS_MANAGE,

  async run(input, ctx) {
    // PRESENCE, not truthiness. `active: false` is the whole point of the
    // deactivate button, and a falsiness check would silently drop it — the
    // same defect a naming edit once had on brand identity.
    const data: Record<string, unknown> = {};
    for (const field of UPDATABLE) {
      if (input[field] !== undefined) data[field] = input[field];
    }

    // Store-scoped in the WHERE, which the tenant-isolation extension requires
    // of every update — an id from a form is not proof of ownership.
    const updated = await prisma.promotion.updateMany({
      where: { id: input.promotionId, storeId: ctx.storeId },
      data,
    });
    if (updated.count === 0) {
      throw new Error("That promotion no longer exists in this business.");
    }

    if (input.productIds !== undefined) {
      const covered = await ownedProductIds(ctx.storeId, input.productIds);
      // Replaced as a set, inside one transaction, so a promotion is never
      // briefly covering nothing while a customer is checking out.
      await prisma.$transaction([
        prisma.promotionProduct.deleteMany({ where: { promotionId: input.promotionId } }),
        prisma.promotionProduct.createMany({
          data: covered.map((productId) => ({ promotionId: input.promotionId, productId })),
        }),
      ]);
    }

    const promotion = await prisma.promotion.findFirstOrThrow({
      where: { id: input.promotionId, storeId: ctx.storeId },
      select: { id: true, name: true, kind: true },
    });
    return {
      message: `Updated "${promotion.name}"`,
      metadata: { promotionId: promotion.id, name: promotion.name, kind: promotion.kind },
    };
  },

  // CLASS B — only the fields the input named are compared, because an update
  // that deliberately left the rest alone must not fail against them.
  async verify(input, ctx): Promise<VerificationOutcome> {
    const promotion = await prisma.promotion.findFirst({
      where: { id: input.promotionId, storeId: ctx.storeId },
      select: {
        name: true, active: true, percentOff: true, amountOffInCents: true,
        startsAt: true, endsAt: true, products: { select: { productId: true } },
      },
    });
    if (!promotion) return { state: "failed", mismatches: ["promotion: no such row after the update"] };

    const expected: Record<string, unknown> = {};
    for (const field of UPDATABLE) {
      if (input[field] !== undefined) expected[field] = input[field];
    }

    const mismatches = namedKeyMismatches(
      expected,
      promotion as unknown as Record<string, unknown>,
      "promotion."
    );

    if (input.productIds !== undefined) {
      const covered = await ownedProductIds(ctx.storeId, input.productIds);
      const stored = promotion.products.map((p) => p.productId).sort();
      if (stored.join(",") !== [...covered].sort().join(",")) {
        mismatches.push(
          `promotion.products: expected ${covered.length} product(s), stored ${stored.length}`
        );
      }
    }

    return verifiedUnless(mismatches);
  },
};

export interface DeletePromotionInput {
  promotionId: string;
}

export const deletePromotionExecutable: Executable<DeletePromotionInput, PromotionMetadata> = {
  action: EXECUTION_ACTIONS.PROMOTION_DELETE,
  requiredPermission: PERMISSIONS.PRODUCTS_MANAGE,

  async run(input, ctx) {
    const promotion = await prisma.promotion.findFirst({
      where: { id: input.promotionId, storeId: ctx.storeId },
      select: { id: true, name: true, kind: true },
    });
    if (!promotion) throw new Error("That promotion no longer exists in this business.");

    // Orders that used it keep everything: the FK is SET NULL and the label,
    // code and amount were copied onto each order at purchase. Deleting a
    // promotion removes the offer, never the history of what people paid.
    await prisma.promotion.deleteMany({ where: { id: input.promotionId, storeId: ctx.storeId } });

    return {
      message: `Deleted "${promotion.name}"`,
      metadata: { promotionId: promotion.id, name: promotion.name, kind: promotion.kind },
    };
  },

  // CLASS A, inverted: the read-back proves ABSENCE.
  async verify(input, ctx): Promise<VerificationOutcome> {
    const still = await prisma.promotion.findFirst({
      where: { id: input.promotionId, storeId: ctx.storeId },
      select: { id: true },
    });
    return verifiedUnless(still ? ["promotion: still present after the delete"] : []);
  },
};
