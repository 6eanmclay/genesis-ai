import type { DiscountCandidate, DiscountKind, DiscountType } from "@/lib/pricing/orderPricing";

// WHETHER A PROMOTION APPLIES, AND IF NOT, WHY NOT.
//
// PURE — no database, no clock of its own. `now` is passed in, which is what
// makes an expiry testable at all: a rule that reads the wall clock can only be
// tested at the moment it happens to be.
//
// SEPARATE FROM THE ARITHMETIC ON PURPOSE. lib/pricing/orderPricing.ts is handed
// a shortlist of offers that already apply and does nothing but choose and
// subtract. Everything that decides *membership* of that shortlist lives here.
// Keeping them apart is what lets the price be one function while eligibility
// grows the conditions a real store needs.
//
// AND WHY NOT MATTERS AS MUCH AS WHETHER. A customer typing a code that has
// expired, one that was switched off this morning, and one that never existed
// are in three different situations, and telling all three "invalid code" is
// how a real customer with a real code from a real email gives up on a purchase
// they were ready to make.

/** The shape this module judges. A row from Promotion, nothing more. */
export interface PromotionLike {
  id: string;
  name: string;
  kind: DiscountKind;
  code: string | null;
  discountType: DiscountType;
  percentOff: number | null;
  amountOffInCents: number | null;
  scope: "ALL_PRODUCTS" | "SELECTED_PRODUCTS";
  active: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
}

/**
 * Why a promotion is not available right now.
 *
 * Distinct values rather than one boolean because each is a different sentence
 * to a customer and a different fix for a merchant.
 */
export type IneligibleReason =
  /** The merchant's switch is off. Includes a paused campaign inside its dates. */
  | "inactive"
  /** Scheduled, but not yet. */
  | "not_started"
  /** Its window has closed. */
  | "expired"
  /** Live and real, but does not cover this product. */
  | "not_eligible_for_product";

export type EligibilityResult = { eligible: true } | { eligible: false; reason: IneligibleReason };

/**
 * How a code is stored and compared: uppercase, trimmed, inner spaces removed.
 *
 * A customer copying SAVE10 out of an email brings a trailing space with it
 * about as often as not, and types it in lowercase more often than that. None
 * of those is a different code, and treating them as one is not leniency — it
 * is refusing to fail a purchase over whitespace.
 */
export function normalizeCode(code: string): string {
  return code.trim().replace(/\s+/g, "").toUpperCase();
}

/**
 * Is this promotion live, and does it cover this product.
 *
 * ORDER MATTERS AND IS DELIBERATE: the switch, then the window, then the
 * product. A merchant who switched a sale off wants to hear that, not that the
 * sale does not cover this item — the first is the reason and the second is a
 * consequence of never getting there.
 */
export function eligibilityOf(
  promotion: PromotionLike,
  params: { productId: string; coveredProductIds: readonly string[]; now: Date }
): EligibilityResult {
  if (!promotion.active) return { eligible: false, reason: "inactive" };

  // Inclusive start, exclusive end. A promotion ending "2026-09-01" is over the
  // instant that day begins, which is what a merchant setting an end date
  // means; the alternative silently gives away a further 24 hours.
  if (promotion.startsAt !== null && params.now < promotion.startsAt) {
    return { eligible: false, reason: "not_started" };
  }
  if (promotion.endsAt !== null && params.now >= promotion.endsAt) {
    return { eligible: false, reason: "expired" };
  }

  if (promotion.scope === "SELECTED_PRODUCTS" && !params.coveredProductIds.includes(params.productId)) {
    return { eligible: false, reason: "not_eligible_for_product" };
  }

  return { eligible: true };
}

/**
 * A promotion, as the pricing function wants it.
 *
 * The label is what the customer will see on the breakdown AND what is frozen
 * onto the order — a code shows as the code they typed, a sale as its name.
 */
export function candidateFrom(promotion: PromotionLike): DiscountCandidate {
  return {
    kind: promotion.kind,
    promotionId: promotion.id,
    label: promotion.kind === "CODE" && promotion.code ? promotion.code : promotion.name,
    code: promotion.code,
    discountType: promotion.discountType,
    percentOff: promotion.percentOff,
    amountOffInCents: promotion.amountOffInCents,
  };
}

/**
 * What the customer is told when a code will not apply.
 *
 * Says which situation they are in without saying anything about the store's
 * other promotions: "not eligible for this product" is a fact about their
 * basket, whereas naming what the code DOES cover would leak a campaign the
 * merchant may not have announced yet.
 */
export function codeRejectionMessage(reason: IneligibleReason | "unknown", code: string): string {
  switch (reason) {
    case "unknown":
      return `We don't recognise the code ${code}.`;
    case "inactive":
      return `The code ${code} isn't available right now.`;
    case "not_started":
      return `The code ${code} isn't active yet.`;
    case "expired":
      return `The code ${code} has expired.`;
    case "not_eligible_for_product":
      return `The code ${code} doesn't apply to this item.`;
  }
}
