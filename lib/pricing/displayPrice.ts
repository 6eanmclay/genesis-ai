import { discountAmountFor, type DiscountCandidate } from "./orderPricing";

// WHAT A PRICE LOOKS LIKE WHEN SOMETHING IS ON SALE.
//
// PURE, and deliberately built on discountAmountFor — the same function the
// charge uses. A storefront that computed its own sale price would be a second
// implementation of the discount, and the two would eventually disagree by a
// cent in front of a customer who noticed.
//
// WHY THIS EXISTS AT ALL. Until now a sale was invisible until checkout: the
// storefront rendered `formatMoney(product.priceInCents)` in four places, none
// of which knew a promotion existed, so a customer discovered a 26% discount
// only after deciding to buy. That is the wrong order — the discount is a
// reason to buy, and it was being kept until after the decision.
//
// PRODUCT.PRICEINCENTS IS NEVER OVERWRITTEN. A sale has dates and a switch;
// burning it into the product would make it unswitchable and would lose the
// original price the moment it was applied. The sale price is derived, every
// render, from promotions that are still live.

export interface DisplayPrice {
  /** The product's own price. Always shown — struck through when on sale. */
  listInCents: number;
  /** What it costs today, or null when nothing applies. */
  saleInCents: number | null;
  /**
   * Rounded, for the badge. Null when not on sale.
   *
   * DERIVED FROM THE ACTUAL MONEY, not from the promotion's percentage: a
   * fixed-amount sale has a real percentage too, and a percentage promotion
   * whose discount was clamped is no longer worth what it says. The badge must
   * describe the price beside it.
   */
  percentOff: number | null;
  /** The sale's own name, for a customer who asks why it is cheaper. */
  label: string | null;
}

/**
 * One product's price, given the sales that apply to it.
 *
 * BEST SINGLE WINS, exactly as at the charge — and for the same reason the
 * order-level rule exists: two overlapping sales are not 40% off.
 */
export function displayPriceFor(
  unitPriceInCents: number,
  candidates: DiscountCandidate[]
): DisplayPrice {
  const listInCents = Math.max(0, Math.round(unitPriceInCents));
  const none: DisplayPrice = { listInCents, saleInCents: null, percentOff: null, label: null };
  if (listInCents <= 0 || candidates.length === 0) return none;

  let best: { amount: number; label: string } | null = null;
  for (const candidate of candidates) {
    const amount = discountAmountFor(candidate, listInCents);
    if (amount <= 0) continue;
    if (best === null || amount > best.amount) best = { amount, label: candidate.label };
  }
  // A sale worth nothing is not a sale. Showing a struck-through price beside
  // an identical one is worse than showing no badge at all.
  if (best === null) return none;

  return {
    listInCents,
    saleInCents: listInCents - best.amount,
    percentOff: Math.round((best.amount / listInCents) * 100),
    label: best.label,
  };
}

/** Is this price worth rendering as a sale? */
export function isOnSale(price: DisplayPrice): boolean {
  return price.saleInCents !== null && price.saleInCents < price.listInCents;
}

/** What the customer actually pays for one of these, sale or not. */
export function effectivePriceInCents(price: DisplayPrice): number {
  return price.saleInCents ?? price.listInCents;
}
