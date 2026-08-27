import { prisma } from "@/lib/prisma";
import { priceOrder, type DiscountCandidate, type OrderPricing } from "@/lib/pricing/orderPricing";
import {
  candidateFrom,
  codeRejectionMessage,
  eligibilityOf,
  normalizeCode,
  type IneligibleReason,
  type PromotionLike,
} from "@/lib/promotions/eligibility";
import type { BagContents } from "./bagCookie";

// A BAG OF IDS BECOMES A PRICED ORDER.
//
// The one place a cookie's contents meet real products and real promotions.
// Everything the customer sees — the bag page, the header count, the checkout
// breakdown — comes out of here, so the storefront and the charge cannot
// disagree about what anything costs.
//
// ============================ HOW A CODE IS SCOPED =========================
//
// A store-wide CODE is an ORDER candidate: it applies to the whole merchandise
// subtotal, and priceOrder compares it against the sum of the line sales so a
// code can never stack on top of one.
//
// A code limited to SELECTED_PRODUCTS is a LINE candidate on the lines it
// covers. It competes with any sale on those same lines — best wins, no
// stacking on the same goods — while leaving products it does not cover at
// full price. That is what "this code is for the rings" means, and it needs no
// special case in the pricing function.

export interface ResolvedBagLine {
  productId: string;
  name: string;
  imageUrl: string | null;
  unitPriceInCents: number;
  quantity: number;
}

export type BagCodeOutcome =
  | { applied: true; code: string }
  | { applied: false; reason: IneligibleReason | "unknown"; message: string };

export interface ResolvedBag {
  /** Products still on sale in this store, in the customer's chosen order. */
  lines: ResolvedBagLine[];
  /** Everything priced. Empty lines yield an empty, zero-total pricing. */
  pricing: OrderPricing;
  /** Present only when a code was typed. Null when nobody entered one. */
  code: BagCodeOutcome | null;
  /**
   * Ids that were in the cookie and are not in the bag.
   *
   * A product deleted or deactivated while it sat in somebody's bag. Reported
   * so the page can say the line went away, and so the cookie can be tidied —
   * never as an error, because a customer must not be stuck on a broken bag.
   */
  droppedProductIds: string[];
}

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

/**
 * Which products each SELECTED_PRODUCTS promotion covers.
 *
 * One query for every promotion in play, rather than one per promotion or —
 * worse — one per line.
 */
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
 * The bag, resolved and priced.
 *
 * `now` is a parameter rather than a call to the clock so an expiry is
 * testable, and so one render judges every promotion against one instant
 * rather than against however long the queries took.
 */
export async function resolveBag(params: {
  storeId: string;
  bag: BagContents;
  shippingInCents?: number;
  now?: Date;
}): Promise<ResolvedBag> {
  const now = params.now ?? new Date();
  const wantedIds = params.bag.items.map((i) => i.p);

  if (wantedIds.length === 0) {
    return {
      lines: [],
      pricing: priceOrder({ lines: [], shippingInCents: params.shippingInCents }),
      code: null,
      droppedProductIds: [],
    };
  }

  // SCOPED TO THIS STORE AND TO ACTIVE PRODUCTS. An id in a cookie is not proof
  // of anything — another store's product simply is not found, which is why the
  // cookie needs no signature.
  const products = await prisma.product.findMany({
    where: { id: { in: wantedIds }, storeId: params.storeId, active: true },
    select: { id: true, name: true, priceInCents: true, imageUrl: true },
  });
  const byId = new Map(products.map((p) => [p.id, p]));

  // The customer's own order is preserved — the order they added things in.
  const lines: ResolvedBagLine[] = [];
  const droppedProductIds: string[] = [];
  for (const item of params.bag.items) {
    const product = byId.get(item.p);
    if (!product) {
      droppedProductIds.push(item.p);
      continue;
    }
    lines.push({
      productId: product.id,
      name: product.name,
      imageUrl: product.imageUrl,
      unitPriceInCents: product.priceInCents,
      quantity: item.q,
    });
  }

  const typed = params.bag.code ? normalizeCode(params.bag.code) : "";

  const [sales, coded] = await Promise.all([
    prisma.promotion.findMany({
      where: { storeId: params.storeId, kind: "SALE", active: true },
      select: PROMOTION_FIELDS,
    }) as Promise<PromotionLike[]>,
    typed === ""
      ? Promise.resolve(null)
      : (prisma.promotion.findFirst({
          where: { storeId: params.storeId, kind: "CODE", code: typed },
          select: PROMOTION_FIELDS,
        }) as Promise<PromotionLike | null>),
  ]);

  const covered = await coveredProductIdsFor(
    [...sales, ...(coded ? [coded] : [])].filter((p) => p.scope === "SELECTED_PRODUCTS").map((p) => p.id)
  );

  const eligibleForProduct = (promotion: PromotionLike, productId: string) =>
    eligibilityOf(promotion, {
      productId,
      coveredProductIds: covered.get(promotion.id) ?? [],
      now,
    }).eligible;

  // --- sales, per line ------------------------------------------------------
  const lineCandidates = new Map<string, DiscountCandidate[]>();
  for (const line of lines) {
    const applicable = sales.filter((sale) => eligibleForProduct(sale, line.productId));
    if (applicable.length > 0) lineCandidates.set(line.productId, applicable.map(candidateFrom));
  }

  // --- the code -------------------------------------------------------------
  let code: BagCodeOutcome | null = null;
  const orderCandidates: DiscountCandidate[] = [];

  if (typed !== "") {
    if (coded === null) {
      code = { applied: false, reason: "unknown", message: codeRejectionMessage("unknown", typed) };
    } else {
      // A code is judged against the bag rather than against one product. It
      // applies when it covers ANY line: a code for the rings is valid in a bag
      // that also holds a mug, it simply does not discount the mug.
      const eligibleLines = lines.filter((l) => eligibleForProduct(coded, l.productId));

      if (eligibleLines.length > 0) {
        const candidate = candidateFrom(coded);
        code = { applied: true, code: coded.code ?? typed };
        if (coded.scope === "ALL_PRODUCTS") {
          orderCandidates.push(candidate);
        } else {
          // Selective: a line candidate on each line it covers. See the header.
          for (const line of eligibleLines) {
            lineCandidates.set(line.productId, [...(lineCandidates.get(line.productId) ?? []), candidate]);
          }
        }
      } else {
        // Live and real, but nothing in this bag qualifies. Judged against the
        // first line only to name the reason — the switch and the window are
        // properties of the promotion, not of any one product, so any line
        // gives the same answer for those.
        const probe = eligibilityOf(coded, {
          productId: lines[0]?.productId ?? "",
          coveredProductIds: covered.get(coded.id) ?? [],
          now,
        });
        const reason: IneligibleReason = probe.eligible ? "not_eligible_for_product" : probe.reason;
        code = { applied: false, reason, message: codeRejectionMessage(reason, typed) };
      }
    }
  }

  const pricing = priceOrder({
    lines: lines.map((line) => ({
      productId: line.productId,
      unitPriceInCents: line.unitPriceInCents,
      quantity: line.quantity,
      candidates: lineCandidates.get(line.productId) ?? [],
    })),
    orderCandidates,
    shippingInCents: params.shippingInCents,
  });

  return { lines, pricing, code, droppedProductIds };
}
