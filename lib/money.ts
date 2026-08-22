// THE ONE PLACE A PRICE BECOMES A STRING.
//
// Store.currency's own schema comment says it plainly: "Every money value
// belonging to this business is in it... the assumption is named here rather
// than assumed everywhere." It was assumed everywhere. Roughly twenty call
// sites wrote `$${(cents / 100).toFixed(2)}` by hand, including the storefront
// a customer buys from and the Stripe line item that charges them, and two of
// those hand-written symbol tables were added in the last two days — by me,
// twice, three lines apart in two different files. That is the smell this
// module exists to remove.
//
// NO LIVE MONEY IS WRONG TODAY, and this is not a bug report dressed up as
// one: nothing in the product ever writes Store.currency, so every store is
// USD and every hardcoded dollar sign is accidentally correct. The defect is
// that the moment one is not — the field exists, the schema promises it means
// something — a GBP store would show a customer "$85.00", charge them 85 USD,
// and settle the owner about sixty-seven pounds. Closing that costs a
// parameter; discovering it costs somebody a real order.
//
// DELIBERATELY NOT Intl.NumberFormat with a currency style. That renders GBP
// as "£85.00" in one locale and "GB£85.00" in another, and the storefront is
// server-rendered against no particular viewer. A shop shows its own prices in
// its own currency the same way to everybody who visits.

const SYMBOLS: Record<string, string> = {
  USD: "$",
  GBP: "£",
  EUR: "€",
  CAD: "CA$",
  AUD: "A$",
  JPY: "¥",
};

/**
 * The symbol for a currency, or the code itself when there is no better one.
 *
 * An unknown code renders as "CHF 85.00" rather than falling back to "$" —
 * showing the wrong symbol is a claim about which money this is, and a
 * three-letter code nobody misreads beats a dollar sign that lies.
 */
export function currencySymbol(currency: string): string {
  return SYMBOLS[currency.toUpperCase()] ?? `${currency.toUpperCase()} `;
}

/**
 * A price, in the store's own money. Always two decimal places: this is a
 * figure somebody pays or is paid, not a headline.
 */
export function formatMoney(cents: number, currency: string): string {
  return `${currencySymbol(currency)}${(cents / 100).toFixed(2)}`;
}

/**
 * The same figure rounded to whole units, for a glance rather than a ledger —
 * a briefing line, a dashboard headline. Thousands are separated.
 */
export function formatMoneyApprox(cents: number, currency: string): string {
  const whole = Math.abs(cents) / 100;
  return `${currencySymbol(currency)}${whole.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}
