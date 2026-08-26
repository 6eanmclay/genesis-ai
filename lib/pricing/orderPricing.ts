// WHAT AN ORDER COSTS. ONE FUNCTION, AND UNTIL NOW THERE WAS NONE.
//
// Before this file the merchandise subtotal did not exist as a value anywhere
// in Genesis. It *was* `product.priceInCents`, read raw from Prisma and handed
// to a payment provider at exactly two call sites, in two different shapes:
//
//   Stripe   unit_amount: product.priceInCents        (Stripe then adds
//            + a separate shipping_rate_data line      shipping and returns
//                                                      amount_total)
//   PayPal   value: (product.priceInCents / 100).toFixed(2)
//            (and no shipping at all)
//
// So there was no place a discount could be applied that both rails would
// honour, and no expression anywhere that a test could pin down as "the total".
// A promotion built on top of Stripe's own coupon API would have silently done
// nothing on PayPal; one built inline at each call site would have been two
// implementations of the same arithmetic, drifting apart the way those two
// already had.
//
// This is that missing place. PURE — no database, no provider, no clock. It is
// handed what has already been resolved and returns the breakdown; every rail,
// every review screen and every stored order reads its numbers from here.
//
// TWO RULES ARE STRUCTURAL RATHER THAN CHECKED ELSEWHERE:
//
//   Shipping is never discounted. It passes through this function untouched
//   and is added after the discount, so no percentage can ever reach it.
//
//   A discount can never exceed what is being discounted. Both the charged
//   subtotal and the RECORDED discount are clamped, so an order can neither
//   go negative nor record having taken more off than the goods cost.

/** Percentage off, or a flat sum off. What every promotion is one of. */
export type DiscountType = "PERCENTAGE" | "FIXED_AMOUNT";

/**
 * Where a discount came from.
 *
 * SALE is the merchant's standing offer and applies by itself; CODE is a
 * customer typing something in. Kept apart because they are answerable to
 * different questions later — "was this on sale" and "did that campaign get
 * used" are not the same report.
 */
export type DiscountKind = "SALE" | "CODE";

/**
 * A discount that has ALREADY been established as applicable to this order.
 *
 * Eligibility — active, in date, in scope, this store — is settled before
 * anything reaches this file. What arrives here is a shortlist of offers that
 * genuinely apply; this function's only remaining job is arithmetic and
 * choosing between them.
 */
export interface DiscountCandidate {
  kind: DiscountKind;
  promotionId: string;
  /** What the customer is shown: the sale's name, or the code as typed. */
  label: string;
  /** Present for a CODE, null for a SALE. Recorded on the order verbatim. */
  code: string | null;
  discountType: DiscountType;
  /** 1-100 for PERCENTAGE, else null. */
  percentOff: number | null;
  /** Cents for FIXED_AMOUNT, else null. */
  amountOffInCents: number | null;
}

/** The discount that actually won, and what it took off. */
export interface AppliedDiscount {
  kind: DiscountKind;
  promotionId: string;
  label: string;
  code: string | null;
  /** Always >= 0 and never more than the list subtotal. */
  amountInCents: number;
}

export interface OrderPricing {
  /** Merchandise at list price, before anything is taken off. */
  listSubtotalInCents: number;
  /** The single winning discount, or null when none applied. */
  discount: AppliedDiscount | null;
  /** What the goods are actually charged at. Never negative. */
  merchandiseSubtotalInCents: number;
  /** Untouched by any discount, by design. */
  shippingInCents: number;
  /** What the customer pays. */
  totalInCents: number;
}

export interface PriceOrderInput {
  unitPriceInCents: number;
  /**
   * One today — the checkout sells a single product and Order.quantity
   * defaults to 1. Named rather than assumed so the day a cart exists this
   * function does not have to be rewritten to notice.
   */
  quantity?: number;
  /** Every discount already established as applicable. May be empty. */
  candidates?: DiscountCandidate[];
  /** What the customer chose to pay for delivery, or 0. */
  shippingInCents?: number;
}

/**
 * What one candidate would take off a given subtotal.
 *
 * CLAMPED AT BOTH ENDS. A 120%-off promotion or a $50 code on a $20 product
 * takes off exactly the subtotal and no more — which is what makes a negative
 * total structurally impossible rather than something a later check has to
 * catch. A malformed candidate (a PERCENTAGE with no percentage) takes off
 * nothing, because the safe reading of "we do not know this discount" is that
 * the customer pays the normal price, not that they pay nothing.
 */
export function discountAmountFor(candidate: DiscountCandidate, subtotalInCents: number): number {
  if (subtotalInCents <= 0) return 0;

  let raw: number;
  if (candidate.discountType === "PERCENTAGE") {
    const percent = candidate.percentOff;
    if (percent === null || !Number.isFinite(percent) || percent <= 0) return 0;
    // Rounded, not floored: a 15% discount on $24.99 is $3.75, and the half
    // cent belongs to whichever side rounding sends it — consistently, so the
    // review screen and the charge cannot disagree by a cent.
    raw = Math.round((subtotalInCents * percent) / 100);
  } else {
    const amount = candidate.amountOffInCents;
    if (amount === null || !Number.isFinite(amount) || amount <= 0) return 0;
    raw = Math.round(amount);
  }

  return Math.min(Math.max(raw, 0), subtotalInCents);
}

/**
 * THE ORDER'S PRICE. Every rail and every screen reads its numbers from here.
 *
 * BEST SINGLE DISCOUNT WINS — discounts never compound. Two well-meant 20%
 * offers running at once give away 20%, not 36%, and a merchant who did not
 * intend the second figure never has to discover it on a settlement report.
 * When a sale and a code would take off the same amount the SALE wins, so the
 * outcome is deterministic rather than dependent on the order of a query.
 */
export function priceOrder(input: PriceOrderInput): OrderPricing {
  const quantity = Math.max(1, Math.floor(input.quantity ?? 1));
  const unit = Math.max(0, Math.round(input.unitPriceInCents));
  const listSubtotalInCents = unit * quantity;
  const shippingInCents = Math.max(0, Math.round(input.shippingInCents ?? 0));

  let best: AppliedDiscount | null = null;
  for (const candidate of input.candidates ?? []) {
    const amountInCents = discountAmountFor(candidate, listSubtotalInCents);
    // A candidate worth nothing is not "applied". Recording a $0.00 discount
    // on an order would make a promotion look used when it changed no money.
    if (amountInCents <= 0) continue;
    if (
      best === null ||
      amountInCents > best.amountInCents ||
      // Tie, and the standing offer takes it.
      (amountInCents === best.amountInCents && candidate.kind === "SALE" && best.kind !== "SALE")
    ) {
      best = {
        kind: candidate.kind,
        promotionId: candidate.promotionId,
        label: candidate.label,
        code: candidate.code,
        amountInCents,
      };
    }
  }

  const merchandiseSubtotalInCents = Math.max(0, listSubtotalInCents - (best?.amountInCents ?? 0));

  return {
    listSubtotalInCents,
    discount: best,
    merchandiseSubtotalInCents,
    // Added AFTER the discount, and never part of what a percentage is taken
    // from. This is the only reason "discounts do not apply to shipping" needs
    // no enforcement anywhere else.
    shippingInCents,
    totalInCents: merchandiseSubtotalInCents + shippingInCents,
  };
}
