// WHERE THE MONEY IS. ONE VOCABULARY, ONE PLACE.
//
// ============ WHY THIS FILE EXISTS (2026-08-30) ========================
//
// Order.status was a bare string with two values anybody could compare against
// by hand, and six places did. Two more values were about to be added, and
// every one of those comparisons would have had to be found and reasoned about
// individually — which is the shape of the mirrored-registry problem this
// codebase has an invariant against: several answers to one question, agreeing
// until the day one of them was not updated.
//
// The audit also found the drift had already started. `notificationSweep`
// filtered on `status: { in: ["paid", "fulfilled"] }` and NOTHING has ever
// written "fulfilled" to this column — fulfilment is its own axis. A phantom
// value, harmless, and evidence that a vocabulary nobody owns does not stay
// true.
//
// ============ THREE AXES, DELIBERATELY SEPARATE =======================
//
// This file is only the FIRST of them. Order already keeps them apart and that
// was the right decision:
//
//   money        Order.status          where the money is       ← this file
//   owner        Order.fulfillmentStatus  what the owner has done
//   carrier      shipmentStatus, deliveredAt  where the parcel is
//
// lib/carriage/lifecycle.ts derives one word for the owner from all three, and
// never stores it, so it cannot drift from what it reads.
//
// ============ STATUS IS NOT THE SAME FACT AS FUNDS ====================
//
// Sean, 2026-08-30: "A warning/inquiry does not mean money moved;
// funds_withdrawn and funds_reinstated are the financial transitions."
//
// So a dispute has TWO records here and they answer different questions:
//
//   Order.status         has the money moved, and which way
//   Order.disputeStatus  what the card network currently says about the claim
//
// A bank inquiry that never becomes a chargeback moves no money at all, and an
// order whose status flipped on an inquiry would have reported a loss that
// never happened. Only positive evidence of funds moving changes the money
// axis — the same discipline runOnce applies when it refuses to guess at an
// outcome it did not witness.

/** Where the money is. The only values Order.status may ever hold. */
export const ORDER_STATUS = {
  /** Money arrived and is ours. */
  PAID: "paid",
  /** Fully returned, deliberately, by the owner or the provider. */
  REFUNDED: "refunded",
  /**
   * Funds have been withdrawn over a claim whose outcome is unknown.
   *
   * Deliberately NOT terminal and deliberately not "lost": the money is gone
   * today and may come back. The closest thing in this codebase is an
   * indeterminate outbound operation — a real state, not a failure.
   */
  DISPUTED: "disputed",
  /** The claim was upheld. The money is gone for good. */
  CHARGED_BACK: "charged_back",
} as const;

export type OrderStatus = (typeof ORDER_STATUS)[keyof typeof ORDER_STATUS];

export const ORDER_STATUSES: OrderStatus[] = Object.values(ORDER_STATUS);

/**
 * What the card network says about the claim itself. Stripe's own vocabulary,
 * kept verbatim rather than translated.
 *
 * The `warning_*` values are inquiries: a bank asking a question before any
 * chargeback exists. They are the whole reason this is separate from the money
 * axis.
 */
export const DISPUTE_STATUS = {
  WARNING_NEEDS_RESPONSE: "warning_needs_response",
  WARNING_UNDER_REVIEW: "warning_under_review",
  WARNING_CLOSED: "warning_closed",
  NEEDS_RESPONSE: "needs_response",
  UNDER_REVIEW: "under_review",
  WON: "won",
  LOST: "lost",
} as const;

export type DisputeStatus = (typeof DISPUTE_STATUS)[keyof typeof DISPUTE_STATUS];

/** An inquiry, not a chargeback. No money has moved because of it. */
export function isInquiryOnly(disputeStatus: string | null): boolean {
  return !!disputeStatus && disputeStatus.startsWith("warning_");
}

/**
 * Is this order's money gone for good?
 *
 * ============ WHAT THIS GATES, AND WHAT IT DOES NOT ==================
 *
 * Buying a shipping label and marking an order fulfilled. Sean, 2026-08-30:
 * "Disputed orders remain fulfillable. Surface a clear warning/risk state, but
 * do not block shipping." A merchant shipping the goods and submitting proof of
 * delivery is a legitimate way to WIN a dispute, and blocking it would remove a
 * real strategy to prevent a loss that has not happened yet.
 *
 * `refunded` and `charged_back` are different: the money went back and is not
 * coming, so posting goods is a second loss on top of the first. Those keep the
 * protection the refund path already had.
 */
export function isMoneyGoneForGood(status: string): boolean {
  return status === ORDER_STATUS.REFUNDED || status === ORDER_STATUS.CHARGED_BACK;
}

/**
 * Should this order count as revenue right now?
 *
 * A disputed order's money has been withdrawn. Counting it while it is out of
 * the account would report income the business does not have — and if the
 * dispute is won it comes back, and this answers true again, because it reads
 * the current status rather than remembering a verdict.
 */
export function countsAsRevenue(status: string): boolean {
  return status === ORDER_STATUS.PAID;
}

/**
 * Has the money been reversed, whether temporarily or for good?
 *
 * What reporting should treat as a reversal rather than a sale. Wider than
 * isMoneyGoneForGood on purpose: a dispute in progress is not a loss yet, and
 * it is not revenue either.
 */
export function isMoneyReversed(status: string): boolean {
  return status !== ORDER_STATUS.PAID;
}

/** The owner-facing reason an action is refused. Their words, not the system's. */
export function refusalReason(status: string): string | null {
  if (status === ORDER_STATUS.REFUNDED) {
    return "This order was refunded — buying a label would post the goods at your expense after the customer got their money back.";
  }
  if (status === ORDER_STATUS.CHARGED_BACK) {
    return "This order was charged back — the bank returned the money to the customer, so posting the goods would be a second loss.";
  }
  return null;
}
