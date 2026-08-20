import { prisma } from "@/lib/prisma";
import { getProfitSummary } from "@/lib/dashboard/whatHappened";
import { getItemPerformance } from "./reasoning";
import { internalItemId } from "./internalMapper";

// M5 (2026-08-18) — J4 can answer "what did I actually keep?"
//
// THE GAP WAS NEVER THE DATA. Product.costInCents is real and populated
// (onboarding captures a self-supplied cost; Printful variants carry the
// partner's own), and getProfitSummary has computed real profit for a while.
// It had exactly one caller — the Analytics page — so an owner could ask J4
// "I sold $400 of candles, what did I keep?" and get nothing, while the number
// sat computed one page away. Same shape of gap M4 closed for the storefront:
// a capability built for one surface, invisible to J4.
//
// NOTHING IS INFERRED, EVER. A product with no recorded cost produces a null
// margin, never an assumed one, and an order with no known cost contributes
// nothing to a profit figure. The single most tempting mistake here is
// treating "no cost recorded" as "cost of zero", which would report a candle
// business as pure profit. Every field below is either a real number or null.
//
// TWO QUESTIONS, TWO SHAPES, DELIBERATELY. "What did I keep overall?" is
// answered by getProfitSummary verbatim — the same number the owner sees on
// Analytics, so J4 can never contradict their own dashboard. "What do I make
// on this product?" is answered as UNIT ECONOMICS (price, cost, what you keep
// per sale), not as a rival per-product profit total.
//
// That is a deliberate choice, not an omission. The two sources genuinely
// disagree: getProfitSummary reads Order rows all-time and counts a refunded
// order's amount as revenue, while getItemPerformance reads canonical
// transactions net of refunds over a window. Reconciling them would mean
// changing getProfitSummary, which would change Analytics — out of scope, and
// the wrong fix regardless. Publishing one total and one per-unit view means
// there is no second total to contradict the first.

export type MarginCoverage = "none" | "partial" | "complete";

export interface StoreMargin {
  /**
   * Null when NO order has a known cost. Deliberately not 0 — getProfitSummary
   * honestly returns 0 there because it summed nothing, and reporting that as
   * "you made $0" would state a fact we do not have. Null is the answer.
   */
  profitInCents: number | null;
  ordersWithKnownCost: number;
  ordersWithUnknownCost: number;
  totalOrders: number;
  coverage: MarginCoverage;
}

/** The coverage judgement — pure, so the honesty rule is directly testable. */
export function summarizeMarginCoverage(summary: {
  profitInCents: number;
  ordersWithKnownCost: number;
  ordersWithUnknownCost: number;
}): StoreMargin {
  const { ordersWithKnownCost, ordersWithUnknownCost } = summary;
  const totalOrders = ordersWithKnownCost + ordersWithUnknownCost;

  const coverage: MarginCoverage =
    ordersWithKnownCost === 0 ? "none" : ordersWithUnknownCost === 0 ? "complete" : "partial";

  return {
    profitInCents: coverage === "none" ? null : summary.profitInCents,
    ordersWithKnownCost,
    ordersWithUnknownCost,
    totalOrders,
    coverage,
  };
}


// ---------------------------------------------------------------------------
// M7 (2026-08-18) — what an order actually costs to fulfil.
//
// Order.shippingCostInCents is written by a real EasyPost label purchase (real
// money, spent through Genesis) and was read by NOTHING — not Analytics, not
// getProfitSummary, not J4. So a $32 candle with $18 of materials and a $12
// USPS label was reported as $14 kept, when the owner kept $2. Postage is
// often the second-largest cost a physical-goods business has, and it is the
// number they price from.
//
// M5's figure is deliberately UNCHANGED and still means exactly what it meant:
// the product-cost margin, identical to what Analytics shows. M7 answers the
// more complete question beside it — "what did I actually keep after postage?"
//
// ONE VARIABLE CHANGES, DELIBERATELY. M7 uses the same order basis M5 uses and
// subtracts recorded postage, so net = M5's profit − postage whenever coverage
// is complete (proved in the suite). That includes inheriting one known quirk
// of getProfitSummary: a refunded order's amount still counts as revenue.
// Correcting that here would make M7 differ from M5 in two ways at once and
// leave nobody able to explain the gap — it is inherited knowingly, stated
// plainly, and left for whoever revisits refund handling as its own change.
//
// NOTHING IS EVER ESTIMATED. Postage is used only where a real label purchase
// recorded it. It is never derived from weight, carrier, product, or from what
// another order's postage happened to be — including another order of the very
// same product.

/**
 * The one description of what this figure covers. Deliberately a value in the
 * data rather than only prose in a prompt: a number whose scope lives only in
 * documentation gets quoted without its scope.
 */
export const PROFIT_BASIS =
  "after recorded product costs and recorded postage; excludes payment-processing fees and every other unrecorded expense";

export interface OrderCostRow {
  productId: string | null;
  amountInCents: number;
  /** From Product.costInCents. Null means no cost was ever recorded. */
  productCostInCents: number | null;
  /** From Order.shippingCostInCents. Null means no label was ever bought. */
  shippingCostInCents: number | null;
}

export interface NetOfPostage {
  /**
   * WHAT THIS IS, EXACTLY: profit after recorded product costs and recorded
   * postage. It is NOT complete business net profit — payment-processing fees,
   * packaging, labour, platform costs and every other real expense Genesis does
   * not store are absent from it. The field is named for its basis rather than
   * called "net profit" precisely so it cannot be quoted as a bottom line.
   *
   * Over orders where BOTH costs are really recorded. Null when no such order
   * exists — never 0, which would read as "you broke even".
   */
  profitAfterRecordedCostsInCents: number | null;
  /** The basis, carried in the data so a reader cannot mistake its scope. */
  basis: string;
  /** Real postage actually paid, summed. Null when none was ever recorded. */
  postageSpentInCents: number | null;
  ordersFullyCosted: number;
  /** Product cost known, no label ever bought — excluded rather than assumed free. */
  ordersWithCostButNoPostage: number;
  ordersWithoutProductCost: number;
  coverage: MarginCoverage;
}

/**
 * Net of postage — pure, and the place the never-estimate rule lives.
 *
 * An order contributes only when it has BOTH a recorded product cost and a
 * recorded postage cost. Anything else is counted and excluded, never filled
 * in from a sibling order.
 */
export function planNetOfPostage(orders: OrderCostRow[]): NetOfPostage {
  let profitAfterRecordedCosts = 0;
  let postageSpentInCents = 0;
  let ordersFullyCosted = 0;
  let ordersWithCostButNoPostage = 0;
  let ordersWithoutProductCost = 0;
  let anyPostageRecorded = false;

  for (const order of orders) {
    if (order.shippingCostInCents !== null) {
      anyPostageRecorded = true;
      postageSpentInCents += order.shippingCostInCents;
    }
    if (order.productCostInCents === null) {
      ordersWithoutProductCost++;
      continue;
    }
    if (order.shippingCostInCents === null) {
      ordersWithCostButNoPostage++;
      continue;
    }
    profitAfterRecordedCosts += order.amountInCents - order.productCostInCents - order.shippingCostInCents;
    ordersFullyCosted++;
  }

  const coverage: MarginCoverage =
    ordersFullyCosted === 0
      ? "none"
      : ordersWithCostButNoPostage === 0 && ordersWithoutProductCost === 0
        ? "complete"
        : "partial";

  return {
    profitAfterRecordedCostsInCents: ordersFullyCosted === 0 ? null : profitAfterRecordedCosts,
    basis: PROFIT_BASIS,
    postageSpentInCents: anyPostageRecorded ? postageSpentInCents : null,
    ordersFullyCosted,
    ordersWithCostButNoPostage,
    ordersWithoutProductCost,
    coverage,
  };
}

export interface ItemMargin {
  /** The canonical item id, matching what queryRecords and events already use. */
  itemId: string;
  name: string;
  priceInCents: number | null;
  /** Null means no cost has ever been recorded for this product. Not zero. */
  costInCents: number | null;
  /** What the owner keeps on one sale. Null whenever either side is unknown. */
  unitMarginInCents: number | null;
  /** Unit margin as a share of price, 0-1. Null when price is null or zero. */
  marginRatio: number | null;
  /** Real sales in the window, from getItemPerformance — never estimated. */
  unitsSold: number;
  revenueInCents: number;
  costKnown: boolean;
  // M7 — real orders of THIS product where both the product cost and a real
  // postage charge were recorded. An order missing either is counted out, never
  // completed from a sibling order of the same product.
  ordersFullyCosted: number;
  /**
   * What was kept on this product's fully-costed orders, after recorded
   * product costs and recorded postage. Null when none qualify.
   *
   * NAMED "kept", NOT "profit", deliberately. M5's own suite guarantees that no
   * per-product field reads as a profit total — the store-level figure is the
   * only total, so nothing here can be quoted as a rival one. That test caught
   * this field on its first naming, which is precisely what it was written for.
   */
  keptAfterRecordedCostsInCents: number | null;
  /** Real postage paid on this product's orders. Null when none was recorded. */
  postageSpentInCents: number | null;
}

/**
 * Unit economics for one product — pure.
 *
 * A negative margin is a real answer and is reported as one. Selling below
 * cost is exactly the thing an owner most needs told plainly, and hiding it
 * behind a floor of zero would be the same class of lie as assuming a missing
 * cost is zero.
 */
export function computeItemMargin(params: {
  priceInCents: number | null;
  costInCents: number | null;
}): { unitMarginInCents: number | null; marginRatio: number | null } {
  const { priceInCents, costInCents } = params;
  if (priceInCents === null || costInCents === null) {
    return { unitMarginInCents: null, marginRatio: null };
  }
  const unitMarginInCents = priceInCents - costInCents;
  // A free or zero-priced product has no meaningful ratio — null rather than
  // a division by zero dressed up as Infinity.
  const marginRatio = priceInCents === 0 ? null : unitMarginInCents / priceInCents;
  return { unitMarginInCents, marginRatio };
}

export interface Profitability {
  /** M5, unchanged: the product-cost margin, identical to Analytics. */
  store: StoreMargin;
  /** M7: the same basis, with real recorded postage subtracted. */
  netOfPostage: NetOfPostage;
  /** Per-product unit economics, best-selling first. */
  items: ItemMargin[];
}

/**
 * Joins real product costs onto real sales performance — pure, so the
 * never-infer rule is provable without a database.
 */
export function planProfitability(params: {
  profitSummary: { profitInCents: number; ordersWithKnownCost: number; ordersWithUnknownCost: number };
  products: { id: string; name: string; priceInCents: number | null; costInCents: number | null }[];
  performance: { itemId: string; orderCount: number; revenueInCents: number }[];
  // M7. Optional so M5's own shape and behaviour are untouched when absent —
  // no orders means no postage claim, which is the honest empty answer.
  orders?: OrderCostRow[];
}): Profitability {
  const performanceById = new Map(params.performance.map((p) => [p.itemId, p]));
  const orders = params.orders ?? [];

  // Per-product postage, grouped from the same real order rows.
  const byProduct = new Map<string, OrderCostRow[]>();
  for (const order of orders) {
    if (!order.productId) continue;
    const existing = byProduct.get(order.productId);
    if (existing) existing.push(order);
    else byProduct.set(order.productId, [order]);
  }

  const items: ItemMargin[] = params.products.map((product) => {
    const itemId = internalItemId(product.id);
    const sold = performanceById.get(itemId);
    const { unitMarginInCents, marginRatio } = computeItemMargin(product);
    // The same pure rule the store-level figure uses, applied to this
    // product's own orders — one definition of "fully costed", not two.
    const productNet = planNetOfPostage(byProduct.get(product.id) ?? []);
    return {
      itemId,
      name: product.name,
      priceInCents: product.priceInCents,
      costInCents: product.costInCents,
      unitMarginInCents,
      marginRatio,
      unitsSold: sold?.orderCount ?? 0,
      revenueInCents: sold?.revenueInCents ?? 0,
      costKnown: product.costInCents !== null,
      ordersFullyCosted: productNet.ordersFullyCosted,
      keptAfterRecordedCostsInCents: productNet.profitAfterRecordedCostsInCents,
      postageSpentInCents: productNet.postageSpentInCents,
    };
  });

  items.sort((a, b) => b.revenueInCents - a.revenueInCents || a.name.localeCompare(b.name));

  return {
    store: summarizeMarginCoverage(params.profitSummary),
    netOfPostage: planNetOfPostage(orders),
    items,
  };
}

/**
 * The database-facing half. Reuses getProfitSummary and getItemPerformance
 * exactly as they are — neither is modified, and Analytics keeps reading the
 * identical number it always did.
 */
export async function getProfitability(storeId: string): Promise<Profitability> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [profitSummary, products, performance, orders] = await Promise.all([
    // M5's figure, untouched — the same call Analytics makes.
    getProfitSummary(storeId),
    prisma.product.findMany({
      where: { storeId },
      select: { id: true, name: true, priceInCents: true, costInCents: true },
    }),
    getItemPerformance(storeId, { since: thirtyDaysAgo }),
    // M7. Read here rather than inside getProfitSummary, so that function and
    // the Analytics page it feeds behave exactly as they always have.
    prisma.order.findMany({
      where: { storeId },
      select: {
        productId: true,
        amountInCents: true,
        // Read so a refunded order contributes ZERO revenue while KEEPING its
        // costs — see the mapping below.
        status: true,
        shippingCostInCents: true,
        product: { select: { costInCents: true } },
      },
    }),
  ]);

  return planProfitability({
    profitSummary,
    products,
    orders: orders.map((o) => ({
      productId: o.productId,
      // A REFUNDED ORDER EARNED NOTHING, BUT STILL COST SOMETHING (2026-08-20).
      //
      // This used to pass the full amount regardless of status, so a refund
      // showed up as profit. Excluding the order entirely would be the opposite
      // error: the product cost and the postage were still spent, and a
      // shipped-then-refunded order is a real loss the owner should see rather
      // than a zero. So the revenue goes to nothing and the costs stay.
      amountInCents: o.status === "refunded" ? 0 : o.amountInCents,
      productCostInCents: o.product?.costInCents ?? null,
      shippingCostInCents: o.shippingCostInCents,
    })),
    performance: performance.map((p) => ({
      itemId: p.item.id,
      orderCount: p.orderCount,
      revenueInCents: p.revenueInCents,
    })),
  });
}
