import { prisma } from "@/lib/prisma";
import {
  candidateFrom,
  codeRejectionMessage,
  eligibilityOf,
  normalizeCode,
  type IneligibleReason,
  type PromotionLike,
} from "./eligibility";
import { priceOrder, type DiscountCandidate, type OrderPricing } from "@/lib/pricing/orderPricing";

// WHAT THIS STORE IS OFFERING ON THIS PRODUCT, RIGHT NOW.
//
// The server half: it reads promotions, hands each to the pure rules in
// eligibility.ts, and returns the shortlist that orderPricing.ts chooses from.
//
// THE BROWSER NEVER NAMES A PRICE. It submits a CODE — a string the customer
// typed — and nothing else. Every amount is derived here, from rows this store
// owns, at the moment of the charge. That rule is not new: the shipping step
// established it (lib/shipping/checkoutShipping.ts:12-15) by taking a rate id
// and re-quoting rather than trusting a number from a form. A discount is the
// same problem with a stronger motive, so it gets the same shape.

export type CodeOutcome =
  | { applied: true; candidate: DiscountCandidate }
  | { applied: false; reason: IneligibleReason | "unknown"; message: string };

export interface ResolvedDiscounts {
  /** Every offer that genuinely applies. orderPricing picks the best one. */
  candidates: DiscountCandidate[];
  /**
   * Present only when a code was actually typed. Null means nobody entered
   * one — which is not the same as entering one that did not work, and the
   * review screen shows nothing at all rather than a cleared error.
   */
  code: CodeOutcome | null;
}

/** Only the columns the rules read. */
const PROMOTION_FIELDS = {
  id: true,
  name: true,
  kind: true,
  code: true,
  discountType: true,
  percentOff: true,
  amountOffInCents: true,
  scope: true,
  active: true,
  startsAt: true,
  endsAt: true,
} as const;

async function coveredProductIdsFor(promotionIds: string[]): Promise<Map<string, string[]>> {
  if (promotionIds.length === 0) return new Map();
  const rows = await prisma.promotionProduct.findMany({
    where: { promotionId: { in: promotionIds } },
    select: { promotionId: true, productId: true },
  });
  const map = new Map<string, string[]>();
  for (const row of rows) {
    const list = map.get(row.promotionId);
    if (list) list.push(row.productId);
    else map.set(row.promotionId, [row.productId]);
  }
  return map;
}

/**
 * Every discount available on this product, plus the fate of a typed code.
 *
 * `now` is a parameter rather than a call to the clock so that an expiry can be
 * tested, and so a single checkout judges every promotion against one instant
 * rather than against however long the queries took.
 */
export async function resolveDiscounts(params: {
  storeId: string;
  productId: string;
  code?: string | null;
  now?: Date;
}): Promise<ResolvedDiscounts> {
  const now = params.now ?? new Date();
  const typed = params.code ? normalizeCode(params.code) : "";

  // SALES ONLY, in one query. A code is looked up separately and by name, so a
  // store with a hundred dormant codes does not load them to check one.
  const sales = (await prisma.promotion.findMany({
    where: { storeId: params.storeId, kind: "SALE", active: true },
    select: PROMOTION_FIELDS,
  })) as PromotionLike[];

  const coded =
    typed === ""
      ? null
      : ((await prisma.promotion.findFirst({
          where: { storeId: params.storeId, kind: "CODE", code: typed },
          select: PROMOTION_FIELDS,
        })) as PromotionLike | null);

  const covered = await coveredProductIdsFor(
    [...sales, ...(coded ? [coded] : [])]
      .filter((p) => p.scope === "SELECTED_PRODUCTS")
      .map((p) => p.id)
  );

  const eligibleFor = (promotion: PromotionLike) =>
    eligibilityOf(promotion, {
      productId: params.productId,
      coveredProductIds: covered.get(promotion.id) ?? [],
      now,
    });

  const candidates: DiscountCandidate[] = [];
  for (const sale of sales) {
    // A sale that does not apply is simply absent. Nobody asked for it by name,
    // so there is nothing to explain.
    if (eligibleFor(sale).eligible) candidates.push(candidateFrom(sale));
  }

  let code: CodeOutcome | null = null;
  if (typed !== "") {
    if (coded === null) {
      code = { applied: false, reason: "unknown", message: codeRejectionMessage("unknown", typed) };
    } else {
      const result = eligibleFor(coded);
      if (result.eligible) {
        const candidate = candidateFrom(coded);
        candidates.push(candidate);
        code = { applied: true, candidate };
      } else {
        code = {
          applied: false,
          reason: result.reason,
          message: codeRejectionMessage(result.reason, typed),
        };
      }
    }
  }

  return { candidates, code };
}

export interface PricedCheckout {
  pricing: OrderPricing;
  code: CodeOutcome | null;
}

/**
 * THE ONE CALL EVERY CHECKOUT PATH MAKES.
 *
 * Both rails and the review screen go through here, so the number a customer is
 * shown and the number they are charged come from the same read of the same
 * rows — not from a value carried across a redirect, and not from arithmetic
 * written twice.
 */
export async function priceCheckout(params: {
  storeId: string;
  productId: string;
  unitPriceInCents: number;
  quantity?: number;
  shippingInCents?: number;
  code?: string | null;
  now?: Date;
}): Promise<PricedCheckout> {
  const { candidates, code } = await resolveDiscounts({
    storeId: params.storeId,
    productId: params.productId,
    code: params.code,
    now: params.now,
  });

  return {
    pricing: priceOrder({
      unitPriceInCents: params.unitPriceInCents,
      quantity: params.quantity,
      candidates,
      shippingInCents: params.shippingInCents,
    }),
    code,
  };
}
