import type { DraftLine } from "./checkoutDraft";

// THE BAG, AS EACH PROVIDER'S OWN LINE ITEMS.
//
// PURE. Both builders below are arithmetic and shaping, so the property that
// actually matters can be asserted without a Stripe or PayPal account:
//
//   WHAT WE ASK THE PROVIDER TO CHARGE MUST EQUAL THE DRAFT'S TOTAL, EXACTLY.
//
// A cent of drift is not a rounding curiosity. Stripe sums its line items and
// charges that; PayPal refuses an order whose items do not add up to its
// breakdown. So a mistake here is either a wrong charge or a failed checkout,
// and neither announces itself in testing with one product.
//
// AND THEY ARE THE RECOVERY PATH. Both providers keep these line items in their
// own records, which is what lets an order be rebuilt when the draft is gone —
// see Order.lineItemSource, tier PROVIDER. That is why the product id travels
// in PayPal's `sku` and why the names are real.

/** One Stripe line item, in the shape checkout.sessions.create wants. */
export interface StripeLineItem {
  price_data: {
    currency: string;
    /** `images` is omitted entirely when the line has none -- see imagesFor. */
    product_data: { name: string; images?: string[] };
    unit_amount: number;
  };
  quantity: number;
}

/**
 * The image Stripe should render for a line, if there is one.
 *
 * AN ABSENT KEY, NOT AN EMPTY ARRAY. `images: []` is a request to render
 * nothing, which is a different statement from "we do not know of an image"
 * and is the sort of difference Stripe is entitled to treat as either.
 *
 * Stripe fetches these itself, so the URL has to be publicly reachable and
 * absolute. It is the same URL the storefront and the bag already render, so
 * the customer confirms against the picture they have been looking at.
 */
function imagesFor(line: DraftLine): { images: string[] } | Record<string, never> {
  return line.imageUrl ? { images: [line.imageUrl] } : {};
}

/**
 * The draft's lines as Stripe line items.
 *
 * THE DISCOUNT IS FOLDED INTO THE PRICE rather than applied through Stripe's
 * own coupon API — the same choice the single-product path makes, and for the
 * same reason: a Stripe coupon would do nothing at all on the PayPal rail, and
 * one arithmetic for both is the whole point of the pricing function.
 *
 * A line whose discounted total does not divide evenly by its quantity is sent
 * as ONE item priced at the line total, with the count in its name. Stripe
 * multiplies unit_amount by quantity, so anything else would be off by the
 * remainder — a few cents that turn into a charge the draft did not promise.
 */
export function toStripeLineItems(lines: DraftLine[], currency: string): StripeLineItem[] {
  const lower = currency.toLowerCase();
  return lines.map((line) => {
    const divides = line.quantity > 0 && line.subtotalInCents % line.quantity === 0;
    if (divides) {
      return {
        price_data: {
          currency: lower,
          product_data: { name: nameFor(line), ...imagesFor(line) },
          unit_amount: line.subtotalInCents / line.quantity,
        },
        quantity: line.quantity,
      };
    }
    return {
      price_data: {
        currency: lower,
        // The count moves into the name so the customer still sees it, and so
        // the provider's own record says how many were bought.
        product_data: { name: `${nameFor(line)} × ${line.quantity}`, ...imagesFor(line) },
        unit_amount: line.subtotalInCents,
      },
      quantity: 1,
    };
  });
}

/** The name a provider shows, with the sale named when there was one. */
function nameFor(line: DraftLine): string {
  return line.promotionLabel ? `${line.productName} (${line.promotionLabel})` : line.productName;
}

/** One PayPal item. `sku` carries the product id home. */
export interface PaypalItem {
  name: string;
  quantity: string;
  unit_amount: { currency_code: string; value: string };
  sku?: string;
}

export interface PaypalAmount {
  currency_code: string;
  value: string;
  breakdown?: {
    item_total: { currency_code: string; value: string };
    discount?: { currency_code: string; value: string };
    shipping?: { currency_code: string; value: string };
  };
}

const money = (cents: number): string => (cents / 100).toFixed(2);

/**
 * The draft's lines as PayPal items, at LIST price.
 *
 * PayPal has a real discount field, so unlike Stripe the discount is expressed
 * rather than folded in: `item_total` is what the goods list at, `discount` is
 * what came off, and the two plus shipping must equal `value` — PayPal rejects
 * the order otherwise. Expressing it also means the customer sees the discount
 * on PayPal's own approval page.
 *
 * THE PRODUCT ID TRAVELS IN `sku`, which is the only structured place PayPal
 * offers for it and is what makes tier-PROVIDER recovery able to relink lines
 * to real products.
 */
export function toPaypalItems(lines: DraftLine[], currency: string): PaypalItem[] {
  const code = currency.toUpperCase();
  return lines.map((line) => ({
    name: line.productName.slice(0, 127),
    quantity: String(line.quantity),
    unit_amount: { currency_code: code, value: money(line.unitPriceInCents) },
    ...(line.productId ? { sku: line.productId.slice(0, 127) } : {}),
  }));
}

/**
 * The amount block that must agree with those items.
 *
 * Built from the same draft, so item_total is the sum of list prices and the
 * arithmetic closes by construction rather than by hope.
 */
export function toPaypalAmount(params: {
  currency: string;
  listSubtotalInCents: number;
  discountInCents: number;
  shippingInCents: number;
  totalInCents: number;
}): PaypalAmount {
  const code = params.currency.toUpperCase();
  return {
    currency_code: code,
    value: money(params.totalInCents),
    breakdown: {
      item_total: { currency_code: code, value: money(params.listSubtotalInCents) },
      ...(params.discountInCents > 0
        ? { discount: { currency_code: code, value: money(params.discountInCents) } }
        : {}),
      ...(params.shippingInCents > 0
        ? { shipping: { currency_code: code, value: money(params.shippingInCents) } }
        : {}),
    },
  };
}

/**
 * Does what we are asking the provider to charge equal the draft's total?
 *
 * The assertion this whole file exists for, as a function so it can be checked
 * before a request leaves rather than discovered in a settlement report.
 */
export function stripeLineItemsTotal(items: StripeLineItem[]): number {
  return items.reduce((sum, i) => sum + i.price_data.unit_amount * i.quantity, 0);
}

/** The same, for PayPal: items at list, less the discount. */
export function paypalItemsTotal(items: PaypalItem[]): number {
  return items.reduce(
    (sum, i) => sum + Math.round(parseFloat(i.unit_amount.value) * 100) * Number(i.quantity),
    0
  );
}
