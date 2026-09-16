// ============ THE server-only SHIM (2026-09-01) =======================
//
// This suite imports app/store/[slug]/actions.ts, which now reaches
// lib/attribution/visit.ts to resolve where a checkout came from -- and that
// module is `server-only`, a package Next provides and plain tsx does not.
//
// Nothing about the suite's meaning changes. `server-only` has no runtime
// behaviour whatsoever; its entire job is to be unresolvable in a CLIENT
// bundle so that importing a server module from client code fails the build.
// See scripts/lib/allowServerOnly.ts for why stubbing its resolution is not a
// test seam.
import "@/scripts/lib/allowServerOnly";
import { readFileSync, readdirSync } from "fs";
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
  items: [] as { productName: string; quantity: number; subtotalInCents: number }[],
  // Recent, so this fixture exercises the NORMAL receipt template.
  placedAt: new Date(),
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
  store: { name: "Cubit and Coil", currency: "GBP", slug: "test-store" },
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
// A HAND-MAINTAINED LIST IS THE BUG IT WAS WRITTEN TO CATCH (corrected
// 2026-08-22, the day after it was written).
//
// The first version of this guard named eleven files. It passed, and it was
// wrong: CustomersList, OrderSummaryCard, RecentOrdersCard and the
// Understanding screen each carried their own `formatCents` with a hardcoded
// dollar sign, and none of them was on the list. Four screens showing an owner
// what their customers had really spent, in a currency nobody had chosen.
//
// That is precisely the mirrored-registry failure ARCHITECTURE.md names as a
// standing invariant, committed by the guard itself. So the list is gone.
//
// NARROWING THE ROOTS WAS THE SAME MISTAKE AGAIN, one size smaller. The second
// version swept four directories and still missed app/j4's own Understanding
// panel, lib/intelligence/insights.ts's revenue sentence, and — worst — the
// shipping rate label a customer reads at checkout, which had become wrong that
// same day when checkout started charging in Store.currency: a GBP store quoted
// "$9.10" and charged 9.10 in pounds.
//
// So the roots are now the whole tree. Every file that converts cents either
// uses lib/money or is named below WITH A REASON.
const ROOTS = ["app", "lib"];

// The conversions that are legitimately NOT display strings. Each is here
// because it produces a NUMBER or an API value, not something a person reads —
// and each is named individually, because "it's probably fine" is how the four
// above survived.
const NOT_A_DISPLAY_STRING: Record<string, string> = {
  // Numbers and API values — nothing a person reads.
  "app/dashboard/ai-actions.ts": "a number handed to a model, never rendered",
  "app/dashboard/products/EditProductForm.tsx": "the value of a number input the owner types into",
  "app/store/[slug]/actions.ts": "the decimal string PayPal's own API requires",
  "lib/intelligence/cognitiveLayer.ts": "numbers handed to a model — price, totalSpent, revenue",
  "lib/fulfillment/printful.ts": "the retail_price string Printful's own API requires",

  // Before a store exists. Onboarding runs before a business, and therefore
  // before a currency, has been chosen — there is no store currency to read,
  // and inventing one would be a guess about a business that does not exist yet.
  "app/StorefrontPreview.tsx": "a preview of a concept, rendered before any store exists",
  "app/onboarding/business/BusinessScreen.tsx": "onboarding, before a business or its currency exists",
  "app/onboarding/launch/LaunchScreen.tsx": "onboarding, before a business or its currency exists",

  // SOMEBODY ELSE'S MONEY, and the most important two entries here. These are
  // QuickBooks invoice totals, whose real currency QuickBooks never gave us.
  // Store.currency is the WRONG answer, not a missing one, and formatting them
  // as the store's currency would convert an unknown into a confident value —
  // worse than a dollar sign, because it looks decided.
  "lib/intelligence/changeDetection.ts": "QuickBooks invoice totals, in QuickBooks' own uncaptured currency",
  "lib/intelligence/insights.ts": "the same QuickBooks totals; its revenue line does use lib/money",
};

/**
 * A single LINE that converts cents and is not a display string.
 *
 * ============ WHY THIS EXISTS AND WHY IT IS NOT AN EXEMPTION (2026-09-16) ===
 *
 * E26 named six remaining sweep hits and classified them: two were the real
 * bug and four were not leaks at all — a form-field unit conversion, PayPal's
 * required decimal, and two Intl.NumberFormat calls that take a REAL currency
 * and hardcode only the `en-US` locale.
 *
 * It refused to put those four in NOT_A_DISPLAY_STRING, and it was right:
 * "An exemption stops the sweep watching a file, and the two Intl call sites
 * genuinely do turn cents into a display string — exempting them would mean a
 * future hardcoded currency" goes unseen. So it left the suite FAILING.
 *
 * That is the other half of the same trap. E26's own amendment records it:
 * "An accepted-red suite hides everything that lands behind it, and three more
 * leaks had." A red suite blinds the whole repository rather than one file.
 *
 * So the grain changes instead. The judgement is made at the LINE, in the
 * source, where a reviewer reads it — not in a list in this file that blinds
 * everything around it. Every other line in these files is still swept.
 *
 * A marker must carry a REASON, and every marker is checked below for still
 * guarding a real conversion, so a stale one fails rather than lingering.
 */
const MARKER = /^\s*\/\/\s*MONEY-SWEEP OK:\s*\S/;
const CONVERTS = /(InCents|cents)\s*\/\s*100/;
/** Any `//` line — a marker's reason is allowed to need more than one. */
const COMMENT = /^\s*\/\//;

/**
 * The first line below `i` that is real code, skipping blanks and the rest of
 * the marker's own comment block.
 *
 * A reason worth writing rarely fits on one line, and the first version of this
 * read the line immediately after the marker — which was the SECOND line of the
 * reason. Every marker then reported itself as guarding a comment.
 */
function codeBelow(lines: string[], i: number): string {
  for (let j = i + 1; j < lines.length; j++) {
    const line = lines[j];
    if (line.trim() === "" || COMMENT.test(line)) continue;
    return line.trim();
  }
  return "";
}

/** Whether the contiguous comment block directly above `n` carries a marker. */
function markedAbove(lines: string[], n: number): boolean {
  for (let j = n - 2; j >= 0; j--) {
    const line = lines[j];
    if (line.trim() === "") continue;
    if (!COMMENT.test(line)) return false;
    if (MARKER.test(line)) return true;
  }
  return false;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(process.cwd(), dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(rel));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

const swept = ROOTS.flatMap(walk);
assert("the sweep actually found files to check", swept.length > 20, String(swept.length));

const leaks: string[] = [];
/** Every marked line found, so a stale marker can be reported below. */
const marked: { file: string; n: number; why: string; guards: string }[] = [];
for (const file of swept) {
  // The one place that is SUPPOSED to convert. Excluded by name rather than by
  // the allowlist above, because it is not an exemption — it is the rule.
  if (file === "lib/money.ts") continue;
  if (NOT_A_DISPLAY_STRING[file]) continue;
  const raw = readFileSync(join(process.cwd(), file), "utf8").split("\n");

  // Every marker in this file, whether or not it guards anything — a marker
  // that guards nothing has to be able to fail, so it is collected here rather
  // than only when an offending line happens to find it.
  raw.forEach((line, i) => {
    if (!MARKER.test(line)) return;
    marked.push({
      file,
      n: i + 1,
      why: line.trim().replace(/^\/\/\s*MONEY-SWEEP OK:\s*/, ""),
      // What it claims to be guarding: the next line that is real code.
      guards: codeBelow(raw, i),
    });
  });

  const offenders = raw
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(
      (l) => CONVERTS.test(l.line) && !l.line.startsWith("//") && !l.line.startsWith("*")
    );
  for (const o of offenders) {
    // MARKED AT THE SITE, one line above. Not a file exemption: everything else
    // in this file is still swept.
    if (markedAbove(raw, o.n)) continue;
    leaks.push(`${file}:${o.n}  ${o.line}`);
  }
}
assert(
  "money becomes a string in exactly one place, across the whole owner and customer path",
  leaks.length === 0,
  leaks.join("\n      ")
);

// AND EVERY LINE MARKER STAYS HONEST, for the same reason the file allowlist
// does. A marker whose line no longer converts anything is a hole sitting open
// in the middle of a swept file, waiting for the next edit to slide into it.
assert("the line markers are actually in use", marked.length > 0, `${marked.length}`);
for (const m of marked) {
  assert(
    `the marker at ${m.file}:${m.n} still guards a conversion`,
    CONVERTS.test(m.guards),
    `guards ${JSON.stringify(m.guards.slice(0, 70))} — reason given: ${m.why}`,
  );
}

// And the allowlist stays honest: an entry for a file that no longer converts
// anything is a stale exemption, and the next real leak would hide behind it.
for (const [file, why] of Object.entries(NOT_A_DISPLAY_STRING)) {
  const text = readFileSync(join(process.cwd(), file), "utf8");
  assert(`the exemption for ${file} is still doing something`, /(InCents|cents)\s*\/\s*100/.test(text), why);
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
