import { prisma } from "@/lib/prisma";
import { candidateFrom, eligibilityOf, type PromotionLike } from "./eligibility";
import { displayPriceFor, type DisplayPrice } from "@/lib/pricing/displayPrice";

// WHAT THIS STORE HAS ON SALE, FOR A WHOLE PAGE AT ONCE.
//
// ONE QUERY PER RENDER, not one per product. A storefront showing sixteen
// products would otherwise ask about promotions sixteen times, and the catalogue
// page is the most-rendered thing in Genesis.
//
// CODES ARE DELIBERATELY ABSENT. A browsing customer has typed nothing, so only
// SALES apply here. A code enters at the bag, is judged against the whole bag,
// and competes with these — see lib/bag/resolveBag.ts.

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
 * Sale prices for a set of products, keyed by product id.
 *
 * `now` is a parameter so one render judges every promotion against one
 * instant, and so an expiry is testable.
 */
export async function salePricesFor(params: {
  storeId: string;
  products: { id: string; priceInCents: number }[];
  now?: Date;
}): Promise<Map<string, DisplayPrice>> {
  const now = params.now ?? new Date();
  const prices = new Map<string, DisplayPrice>();

  // Every product gets an entry, on sale or not, so a caller never has to
  // decide what a missing key means.
  const plain = () => params.products.forEach((p) => prices.set(p.id, displayPriceFor(p.priceInCents, [])));

  if (params.products.length === 0) return prices;

  const sales = (await prisma.promotion.findMany({
    where: { storeId: params.storeId, kind: "SALE", active: true },
    select: PROMOTION_FIELDS,
  })) as PromotionLike[];

  if (sales.length === 0) {
    plain();
    return prices;
  }

  const selective = sales.filter((s) => s.scope === "SELECTED_PRODUCTS").map((s) => s.id);
  const covered = new Map<string, string[]>();
  if (selective.length > 0) {
    const rows = await prisma.promotionProduct.findMany({
      where: { promotionId: { in: selective } },
      select: { promotionId: true, productId: true },
    });
    for (const row of rows) {
      const list = covered.get(row.promotionId);
      if (list) list.push(row.productId);
      else covered.set(row.promotionId, [row.productId]);
    }
  }

  for (const product of params.products) {
    const applicable = sales.filter(
      (sale) =>
        eligibilityOf(sale, {
          productId: product.id,
          coveredProductIds: covered.get(sale.id) ?? [],
          now,
        }).eligible
    );
    prices.set(product.id, displayPriceFor(product.priceInCents, applicable.map(candidateFrom)));
  }

  return prices;
}

/** The same question for one product, when a page only shows one. */
export async function salePriceFor(params: {
  storeId: string;
  product: { id: string; priceInCents: number };
  now?: Date;
}): Promise<DisplayPrice> {
  const map = await salePricesFor({ storeId: params.storeId, products: [params.product], now: params.now });
  return map.get(params.product.id) ?? displayPriceFor(params.product.priceInCents, []);
}
