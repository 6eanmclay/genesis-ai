// HOW AN ORDER'S TOTAL WAS ARRIVED AT.
//
// ============ WHY THIS IS A MODULE AND NOT A FEW LINES IN THE PAGE =====
//
// It was a few lines in the page, and the sabotage run proved that was wrong.
// The verification suite carried its own COPY of the arithmetic, so breaking
// the page's version — making it trust only the order-level columns, or stop
// naming the promotion — left the suite green. The suite was checking a
// duplicate of the thing it was supposed to be checking.
//
// That is the seam Sean has already named once: a test seam that replaces what
// it tests. One function, imported by the page and by the suite, is the only
// arrangement where breaking it can fail.
//
// ============ WHY IT IS NOT SIMPLY READING THE COLUMNS =================
//
// On the real orders in production, Order.listSubtotalInCents and
// Order.discountInCents are BOTH NULL while every OrderItem carries its own
// list price and discount. A page that trusted the columns would print no
// discount over an order that had "Back to School Sale!" applied to every line
// — the merchant's own promotion, invisible on the merchant's own screen.
//
// Neither source is preferred on principle. The column is what checkout
// recorded for the order; the items are what it recorded per line. Where the
// first is absent the second is the same fact, and where the first is present
// it wins.

export interface OrderMoneyInput {
  listSubtotalInCents: number | null;
  discountInCents: number | null;
  appliedPromotionLabel: string | null;
}

export interface OrderMoneyLine {
  listInCents: number;
  discountInCents: number;
  promotionLabel: string | null;
}

export interface OrderMoney {
  /** What the goods came to before any discount. Null when nothing records it. */
  subtotal: number | null;
  /** What came off. Null when nothing records it; 0 is a real answer. */
  discount: number | null;
  /** The promotion's own name, for saying WHY money came off. */
  promotionLabel: string | null;
}

export function orderMoney(order: OrderMoneyInput, items: OrderMoneyLine[]): OrderMoney {
  const itemList = items.reduce((n, i) => n + i.listInCents, 0);
  const itemDiscount = items.reduce((n, i) => n + i.discountInCents, 0);

  return {
    subtotal: order.listSubtotalInCents ?? (items.length > 0 ? itemList : null),
    discount: order.discountInCents ?? (items.length > 0 ? itemDiscount : null),
    // The order's own label first, then whichever line carries one. A single
    // promotion across every line is the shape every real order has so far, and
    // naming it once is what makes the discount explicable rather than a
    // number that appeared.
    promotionLabel:
      order.appliedPromotionLabel ?? items.find((i) => i.promotionLabel)?.promotionLabel ?? null,
  };
}
