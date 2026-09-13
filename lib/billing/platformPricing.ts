import { formatMoney } from "@/lib/money";

// WHAT GENESIS ITSELF CHARGES, SAID OUT LOUD.
//
// ============ TWO BUTTONS THAT TOOK MONEY WITHOUT NAMING IT ============
//
// Billing's Subscribe cards rendered a plan name, its monthly Growth Point
// allowance and a "Subscribe" button. The Growth Points packs rendered a
// label, "+4 Growth Points" and an "Invest" button. Neither showed a price,
// and both submit straight into a live Stripe Checkout Session. The owner
// first learned what they were about to pay on Stripe's own page.
//
// The figure was never missing. Plan.priceInCents and
// GrowthPointPackage.priceInCents are both populated and both carry the same
// comment saying what they are for — the schema's is explicit:
//
//   "Display only: the real charge always comes from Stripe's own Price
//    object at checkout time, this is a cached snapshot so the
//    billing/growth-points pages can show a real '$X/month' without an extra
//    Stripe API round-trip on every page load."
//
// Stored for these two pages to display, and dropped by both of them.
//
// ============ USD, AND NOT THE STORE'S CURRENCY ========================
//
// This is the one place in the product where the money is NOT the store's.
// A shop selling in GBP still pays Genesis in dollars: scripts/
// provision-pricing.ts creates every plan Price and every pack Price with
// `currency: "usd"`. Formatting these with store.currency would put a £ in
// front of a figure Stripe will charge in $ — a wrong currency symbol on a
// real price is worse than no price at all, which is the whole reason this
// constant exists rather than a call site reaching for the store's.
//
// verify-platform-pricing.ts reads provision-pricing.ts and fails if the two
// ever disagree.
export const PLATFORM_BILLING_CURRENCY = "USD";

/**
 * A platform price, or null when there isn't a real one.
 *
 * Null is a first-class answer and the caller must render nothing for it:
 * Plan.priceInCents is nullable by design ("ships empty, populated later,
 * never guessed"), and a plan without a cached price must show no price
 * rather than a zero, a dash, or a guess.
 */
export function formatPlatformPrice(cents: number | null | undefined): string | null {
  if (typeof cents !== "number" || !Number.isFinite(cents)) return null;
  return formatMoney(cents, PLATFORM_BILLING_CURRENCY);
}

/** The same figure as a recurring charge. Plans are `interval: "month"`. */
export function formatPlatformMonthlyPrice(cents: number | null | undefined): string | null {
  const price = formatPlatformPrice(cents);
  return price === null ? null : `${price}/month`;
}
