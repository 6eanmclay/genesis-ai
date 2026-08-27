// WHAT A PAYMENT PROVIDER IS, WITH NOTHING BEHIND IT.
//
// ============ WHY THIS IS ITS OWN FILE ===================================
//
// The type and the labels below are needed by CLIENT components — the payment
// chooser on the bag and on the checkout review. They used to live in
// ./router.ts beside the logic that reads them, which is where they belong by
// meaning and is exactly wrong by dependency: router.ts imports prisma, so a
// `"use client"` file importing one label dragged the database client into the
// browser bundle.
//
// It does not fail loudly. The page simply stops rendering — an empty body,
// no error anyone reads, and every assertion about what the customer sees
// failing at once. Found by scripts/verify-checkout-presentation.ts, which is
// the only kind of test that could have: nothing about the source looks wrong.
//
// So: no imports here, and nothing may be added that needs one.

export type PaymentProviderChoice = "STRIPE" | "PAYPAL";

/**
 * Preference order, used only where the customer has not chosen.
 *
 * Also the order they are OFFERED in, which is the same list on purpose —
 * two lists would be two places for a provider to go missing.
 */
export const PAYMENT_PROVIDER_PREFERENCE: PaymentProviderChoice[] = ["STRIPE", "PAYPAL"];

/**
 * How a provider is named to a customer. Never the enum value.
 *
 * "Card" rather than "Stripe": the customer is choosing how to pay, not which
 * company processes it, and most of them have never heard of the processor.
 */
export const PAYMENT_PROVIDER_LABELS: Record<PaymentProviderChoice, string> = {
  STRIPE: "Card",
  PAYPAL: "PayPal",
};

/**
 * What the customer chose, if they were allowed to choose it.
 *
 * PURE, so the rule can be proven without a database — and the rule is the
 * whole point:
 *
 *   A REQUEST IS HONOURED ONLY IF IT IS GENUINELY AVAILABLE. The value arrives
 *   from a form field, which means it arrives from the browser, which means it
 *   can say anything. "PAYPAL" from a store that never connected PayPal is not
 *   an error to raise at a customer mid-purchase — it is a stale page or a
 *   tampered field, and the honest response is to charge them through a rail
 *   that works rather than to fail the sale.
 */
export function chooseProvider(
  available: PaymentProviderChoice[],
  requested: string | null | undefined,
): PaymentProviderChoice {
  if (available.length === 0) {
    throw new Error("No connected payment provider — cannot select a checkout provider.");
  }
  const normalized = requested?.trim().toUpperCase();
  const match = available.find((provider) => provider === normalized);
  // The first available one is the default, and `available` is already in
  // preference order — so an absent choice behaves exactly as it always did.
  return match ?? available[0];
}
