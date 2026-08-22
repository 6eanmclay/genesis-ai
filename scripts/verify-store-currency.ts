import { readFileSync } from "fs";
import { join } from "path";
import { formatMoney, formatMoneyApprox, currencySymbol } from "@/lib/money";
import { buildConfirmationEmail } from "@/lib/orders/orderConfirmation";
import { buildOwnerSaleEmail } from "@/lib/orders/notifyOwnerOfSale";
import { buildCommerceLead } from "@/lib/dashboard/commerceLead";

// A SHOP SHOWS ITS PRICES IN ITS OWN MONEY:
//
//   npx tsx scripts/verify-store-currency.ts
//
// Store.currency's schema comment declares itself authoritative for "every
// money value belonging to this business... the assumption is named here rather
// than assumed everywhere". It was assumed everywhere. Roughly twenty call
// sites converted cents to a string with a hardcoded dollar sign, including the
// storefront a customer buys from, the receipt they are emailed, and the Stripe
// line item that charges them.
//
// NOTHING WAS LOSING MONEY, and that is exactly why this is a suite rather than
// a bug report. No code path in this product ever writes Store.currency, so
// every store is USD today and every hardcoded dollar sign was accidentally
// correct. The defect is invisible until the first store that is not USD, and
// at that moment it stops being a display bug: a customer is shown one currency
// and charged another, and the owner settles the difference.
//
// So every assertion below runs a NON-USD store through the real builders. A
// suite that tested USD would agree with the bug.
//
// SECTION 4 IS THE ONE THAT LASTS. Fixing twenty call sites is worth nothing if
// the twenty-first is written next month, and it would be, because formatting
// money inline is the obvious thing to do.

let failures = 0;
function assert(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `\n      ${detail}` : ""}`);
}

// ============================================================================
console.log("\n=== 1. The formatter says which money it means ===\n");
// ============================================================================
assert("dollars", formatMoney(8_500, "USD") === "$85.00", formatMoney(8_500, "USD"));
assert("pounds", formatMoney(8_500, "GBP") === "£85.00", formatMoney(8_500, "GBP"));
assert("euros", formatMoney(8_500, "EUR") === "€85.00", formatMoney(8_500, "EUR"));
assert("a lowercase code still resolves", formatMoney(8_500, "gbp") === "£85.00", formatMoney(8_500, "gbp"));

// THE HONESTY ASSERTION. An unknown code must not fall back to a dollar sign:
// showing the wrong symbol is a claim about which money this is, and a
// three-letter code nobody misreads beats a dollar sign that lies.
assert(
  "an unknown currency shows its code, never a dollar sign",
  formatMoney(8_500, "CHF") === "CHF 85.00",
  formatMoney(8_500, "CHF")
);
assert("and the symbol lookup agrees", !currencySymbol("CHF").includes("$"), currencySymbol("CHF"));

// A registry keyed by a free string. SYMBOLS["constructor"] is a function on any
// plain object, and `?? code` does not catch a function — see
// verify-registry-lookups.ts for the six times this exact shape shipped.
for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
  assert(
    `"${key}" resolves to a string, not an inherited function`,
    typeof currencySymbol(key) === "string",
    String(typeof currencySymbol(key))
  );
  assert(`and "${key}" does not render as dollars`, !currencySymbol(key).startsWith("$"), currencySymbol(key));
}

assert(
  "the glance figure drops the pennies",
  formatMoneyApprox(8_549, "GBP") === "£85",
  formatMoneyApprox(8_549, "GBP")
);
assert("and the ledger figure keeps them", formatMoney(8_549, "GBP") === "£85.49", formatMoney(8_549, "GBP"));

// ============================================================================
console.log("\n=== 2. What the customer is shown, in the money they paid ===\n");
// ============================================================================
const ORDER = {
  id: "order_1",
  productName: "Tensor Ring",
  quantity: 1,
  amountInCents: 8_500,
  buyerEmail: "buyer@test.local",
  externalOrderId: "ext-1",
  shippingAddress: null,
  selectedShippingCarrier: null,
  selectedShippingService: null,
  selectedShippingEstDays: null,
};

const receipt = buildConfirmationEmail({
  order: ORDER,
  store: { name: "Cubit and Coil", currency: "GBP" },
});
assert("the receipt quotes pounds", receipt.html.includes("£85.00"), receipt.html);
assert("and never a dollar sign", !receipt.html.includes("$"), receipt.html);

// ============================================================================
console.log("\n=== 3. What the owner is shown, in the money they take ===\n");
// ============================================================================
const notice = buildOwnerSaleEmail({
  order: ORDER,
  store: { name: "Cubit and Coil", currency: "GBP" },
  ownerEmail: "owner@test.local",
});
assert("the sale notification quotes pounds", notice.subject.includes("£85.00"), notice.subject);
assert(
  "and never a dollar sign",
  !notice.subject.includes("$") && !notice.html.includes("$"),
  `${notice.subject} / ${notice.html}`
);

const lead = buildCommerceLead(
  {
    hasPriorAnchor: true,
    sinceIso: "2026-08-21T09:00:00.000Z",
    orderCount: 3,
    revenueDeltaInCents: 25_500,
    newCustomerCount: 1,
    recentBusinessEvents: [],
  },
  "GBP"
);
assert("Commerce's own lead quotes pounds", lead?.text.includes("£255") === true, String(lead?.text));
assert("and never a dollar sign", lead?.text.includes("$") === false, String(lead?.text));

// The same figures in a different store's money must actually differ. Without
// this, every assertion above would also pass against a formatter that ignored
// its argument and happened to be hardcoded to pounds.
const inDollars = buildCommerceLead(
  {
    hasPriorAnchor: true,
    sinceIso: "2026-08-21T09:00:00.000Z",
    orderCount: 3,
    revenueDeltaInCents: 25_500,
    newCustomerCount: 1,
    recentBusinessEvents: [],
  },
  "USD"
);
assert("a USD store reads differently", inDollars?.text !== lead?.text, `${inDollars?.text} vs ${lead?.text}`);

// ============================================================================
console.log("\n=== 4. Money becomes a string in exactly one place ===\n");
// ============================================================================
// The standing guard, and the reason the twenty-first call site does not get
// written. Every file below either shows a figure to somebody or charges one,
// and has the store in hand while doing it.
//
// The pattern is the CONVERSION, not the dollar sign — catching `InCents / 100`
// also catches a hand-written pound sign, which is the same defect wearing the
// right symbol by luck.
const COMMERCE_PATH = [
  "app/store/[slug]/page.tsx",
  "app/store/[slug]/products/[productId]/page.tsx",
  "app/store/[slug]/success/page.tsx",
  "app/store/[slug]/ship/[productId]/ShippingStep.tsx",
  "app/dashboard/OrdersList.tsx",
  "app/dashboard/HomeWorkspace.tsx",
  "app/dashboard/BusinessPulse.tsx",
  "app/dashboard/analytics/page.tsx",
  "lib/orders/orderConfirmation.ts",
  "lib/orders/notifyOwnerOfSale.ts",
  "lib/dashboard/commerceLead.ts",
];

for (const file of COMMERCE_PATH) {
  const source = readFileSync(join(process.cwd(), file), "utf8");
  const offenders = source
    .split("\n")
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter((l) => /InCents\s*\/\s*100/.test(l.line) && !l.line.startsWith("//") && !l.line.startsWith("*"));
  assert(
    `${file} formats no money of its own`,
    offenders.length === 0,
    offenders.map((o) => `${o.n}: ${o.line}`).join("\n      ")
  );
}

// AND THE CHARGE ITSELF, which costs real money rather than credibility.
const checkout = readFileSync(join(process.cwd(), "app/store/[slug]/actions.ts"), "utf8");
assert(
  "the Stripe rail charges in the store's currency",
  checkout.includes("currency: store.currency.toLowerCase()"),
  "a hardcoded currency here shows one price and charges another"
);
assert("the PayPal rail charges in the store's currency", checkout.includes("currency_code: store.currency.toUpperCase()"));
assert(
  "and neither names a currency of its own",
  !/currency:\s*"usd"/i.test(checkout) && !/currency_code:\s*"USD"/.test(checkout),
  checkout
    .split("\n")
    .filter((l) => /currency:\s*"|currency_code:\s*"/.test(l))
    .join("\n      ")
);

// THE DELIBERATE EXCEPTION, asserted so it stays deliberate. Change detection
// formats QuickBooks invoice totals, whose real currency QuickBooks never gave
// us. Store.currency is the WRONG answer there, not a missing one, and a future
// sweep that "finishes the job" would be converting an unknown into a confident
// value.
const changeDetection = readFileSync(join(process.cwd(), "lib/intelligence/changeDetection.ts"), "utf8");
assert(
  "change detection still explains why it is exempt",
  changeDetection.includes("QUICKBOOKS"),
  "the exemption must carry its reason or it reads as an oversight"
);
assert(
  "and does not reach for the store's currency",
  !changeDetection.includes("store.currency"),
  "a QuickBooks invoice is not denominated in this store's configured currency"
);

console.log(`\n${failures === 0 ? "All store-currency assertions passed." : `${failures} assertion(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
