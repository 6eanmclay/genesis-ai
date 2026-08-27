import type { DraftLine } from "./checkoutDraft";

// TURNING A PAID CHECKOUT INTO AN ORDER'S LINE ITEMS.
//
// PURE, and this is the file the three-tier rule actually lives in.
//
//   DRAFT     the frozen contract. The normal path.
//   PROVIDER  the draft is gone; the provider's own line items are used. Not a
//             fabrication — it is what the customer was charged for.
//   NONE      neither is available. The financial record is preserved and
//             NOTHING is invented.
//
// THE RULE IN ONE SENTENCE: a payment always becomes an order, and line items
// are never guessed. Money that moved with nothing to show for it is the worst
// outcome available; an order presenting a made-up basket as fact is the second
// worst, and it is worse than admitting the contents are unknown.

export type LineItemSource = "DRAFT" | "PROVIDER" | "NONE";

/** What an OrderItem row needs. Shared by every tier that produces one. */
export interface OrderLineInput {
  productId: string | null;
  productName: string;
  quantity: number;
  unitPriceInCents: number;
  listInCents: number;
  discountInCents: number;
  subtotalInCents: number;
  promotionId: string | null;
  promotionLabel: string | null;
}

export interface RecoveredLines {
  source: LineItemSource;
  lines: OrderLineInput[];
  /** For the owner-facing record when the source is NONE. */
  note: string | null;
}

/** Tier 1. The draft said so. */
export function linesFromDraft(draftLines: DraftLine[]): RecoveredLines {
  return {
    source: "DRAFT",
    lines: draftLines.map((line) => ({
      productId: line.productId,
      productName: line.productName,
      quantity: line.quantity,
      unitPriceInCents: line.unitPriceInCents,
      listInCents: line.listInCents,
      discountInCents: line.discountInCents,
      subtotalInCents: line.subtotalInCents,
      promotionId: line.promotionId,
      promotionLabel: line.promotionLabel,
    })),
    note: null,
  };
}

/** What Stripe returns from listLineItems, reduced to what matters. */
export interface StripeLineItemLike {
  description?: string | null;
  quantity?: number | null;
  amount_total?: number | null;
  price?: { unit_amount?: number | null } | null;
}

/**
 * Tier 2, Stripe.
 *
 * `amount_total` is what that line actually cost, which is the figure worth
 * keeping — Stripe already has the discount folded into the unit amount we
 * sent it, so the line total is both the list and the subtotal here. Recording
 * a discount we cannot separate would be inventing an attribution.
 */
export function linesFromStripe(items: StripeLineItemLike[]): RecoveredLines {
  const lines: OrderLineInput[] = [];
  for (const item of items) {
    const quantity = typeof item.quantity === "number" && item.quantity > 0 ? item.quantity : 1;
    const total =
      typeof item.amount_total === "number"
        ? item.amount_total
        : typeof item.price?.unit_amount === "number"
          ? item.price.unit_amount * quantity
          : null;
    const name = item.description?.trim();
    // A line with no name or no money is not a line. Half a record is worse
    // than an honest absence, because it looks complete.
    if (!name || total === null || total < 0) continue;
    lines.push({
      productId: null,
      productName: name,
      quantity,
      unitPriceInCents: Math.round(total / quantity),
      listInCents: total,
      discountInCents: 0,
      subtotalInCents: total,
      promotionId: null,
      promotionLabel: null,
    });
  }
  return lines.length > 0
    ? { source: "PROVIDER", lines, note: null }
    : noLines("Stripe returned no usable line items.");
}

/** What PayPal returns inside a purchase unit. */
export interface PaypalItemLike {
  name?: string | null;
  sku?: string | null;
  quantity?: string | null;
  unit_amount?: { value?: string | null } | null;
}

/**
 * Tier 2, PayPal.
 *
 * Items are sent at LIST price with the discount expressed in the breakdown, so
 * these come back as list — and `sku` carries the product id, which is what
 * lets a recovered line relink to a real product.
 */
export function linesFromPaypal(items: PaypalItemLike[]): RecoveredLines {
  const lines: OrderLineInput[] = [];
  for (const item of items) {
    const name = item.name?.trim();
    const quantity = Number(item.quantity);
    const unit = Number(item.unit_amount?.value);
    if (!name || !Number.isFinite(quantity) || quantity <= 0) continue;
    if (!Number.isFinite(unit) || unit < 0) continue;
    const unitPriceInCents = Math.round(unit * 100);
    lines.push({
      productId: item.sku?.trim() || null,
      productName: name,
      quantity: Math.floor(quantity),
      unitPriceInCents,
      listInCents: unitPriceInCents * Math.floor(quantity),
      // The order-level discount is not attributed per line here. It is
      // recorded on the ORDER from the breakdown; splitting it across lines
      // would be inventing an allocation PayPal never told us.
      discountInCents: 0,
      subtotalInCents: unitPriceInCents * Math.floor(quantity),
      promotionId: null,
      promotionLabel: null,
    });
  }
  return lines.length > 0
    ? { source: "PROVIDER", lines, note: null }
    : noLines("PayPal returned no usable line items.");
}

/** Tier 3. Nothing is invented. */
export function noLines(reason: string): RecoveredLines {
  return { source: "NONE", lines: [], note: reason };
}

/**
 * The name that goes on the Order row itself.
 *
 * Order.productName is a required column read by 154 call sites, so it always
 * says something. With lines it names the first and counts the rest; without
 * them it says so plainly rather than borrowing a name from nowhere — the same
 * honesty as the "Unknown product" the order path already uses.
 */
export function primaryNameFor(recovered: RecoveredLines): string {
  if (recovered.lines.length === 0) return "Order contents unavailable";
  if (recovered.lines.length === 1) return recovered.lines[0].productName;
  return `${recovered.lines[0].productName} and ${recovered.lines.length - 1} more`;
}

/** Units across the whole order, for Order.quantity. */
export function totalQuantity(recovered: RecoveredLines): number {
  return recovered.lines.reduce((sum, l) => sum + l.quantity, 0) || 1;
}

/**
 * The product to link on the Order row itself, when there is an unambiguous one.
 *
 * Null for a multi-product bag: Order.productId means "this order was for that
 * product", and pointing it at one of four would make every report that reads
 * it quietly wrong.
 */
export function primaryProductId(recovered: RecoveredLines): string | null {
  return recovered.lines.length === 1 ? recovered.lines[0].productId : null;
}
