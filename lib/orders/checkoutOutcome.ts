// What a buyer is told when checkout does not finish cleanly (2026-08-20).
//
// The PayPal return route had four exits that did `redirect(storeUrl)` and
// nothing else: missing credentials, a failed capture, a failed re-fetch of an
// already-captured order, and a custom_id that did not match the store. In every
// one of them a person had just approved a payment on PayPal's site and was
// dropped back on the shop's front page with no message at all — no idea whether
// they had been charged, nothing to quote to anyone, nothing to do next.
//
// Two of those four happen AFTER PayPal has taken the money. Silence there is
// the worst version of a false state: not a wrong claim, but no claim, leaving
// the buyer to assume whichever is more comfortable.
//
// So there are exactly two honest things to say, because there are exactly two
// situations a buyer can be in:

export type CheckoutProblem =
  /**
   * The payment did not complete. Nothing was taken, or anything taken will be
   * released by the provider. Safe to try again.
   */
  | "payment_not_completed"
  /**
   * The payment DID complete and the order could not be recorded. Never tell
   * this person to try again — they would pay twice.
   */
  | "payment_taken_unconfirmed";

export interface CheckoutProblemNotice {
  /** Leading sentence, stating plainly what happened to their money. */
  headline: string;
  /** What happens next, and what they should do. */
  detail: string;
  /** Whether retrying is safe. Drives whether a "try again" affordance shows. */
  safeToRetry: boolean;
}

/**
 * The buyer-facing notice for a checkout problem — pure.
 *
 * `reference` is the provider's own order id, which is the only thing that lets
 * a human reconcile this later. It is shown rather than hidden, because a buyer
 * with a reference can be helped and a buyer without one cannot.
 */
export function checkoutProblemNotice(problem: CheckoutProblem): CheckoutProblemNotice {
  if (problem === "payment_taken_unconfirmed") {
    return {
      headline: "Your payment went through, but we couldn't finish setting up your order.",
      // The single most important sentence on this page. A buyer who retries
      // here pays twice, and they will retry unless told not to.
      detail:
        "Please don't pay again. Contact the store with the reference below and they'll sort it out.",
      safeToRetry: false,
    };
  }
  return {
    headline: "We couldn't complete your payment.",
    detail:
      "You haven't been charged. You can try again, or contact the store with the reference below.",
    safeToRetry: true,
  };
}

/** Parse the query parameter back, ignoring anything unrecognised. */
export function parseCheckoutProblem(value: string | null | undefined): CheckoutProblem | null {
  if (value === "payment_not_completed" || value === "payment_taken_unconfirmed") return value;
  return null;
}
