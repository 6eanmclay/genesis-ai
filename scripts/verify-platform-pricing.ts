import { readFileSync } from "node:fs";
import {
  PLATFORM_BILLING_CURRENCY,
  formatPlatformPrice,
  formatPlatformMonthlyPrice,
} from "@/lib/billing/platformPricing";
import { growthPointPackages } from "@/lib/growthPoints/purchaseCatalog";

// A BUTTON THAT TAKES MONEY SAYS WHAT IT COSTS:
//
//   part of the code-only sweep — npx tsx scripts/run-code-suites.ts platform-pricing
//
// ============ THE DEFECT (2026-09-13) ==================================
//
// Billing's Subscribe cards and the Growth Point packs both submitted into a
// live Stripe Checkout Session while naming no price. The owner learned what
// they were paying on Stripe's page, after committing to the flow.
//
// The number was never missing. Both priceInCents fields are populated and
// both say what they are for; the schema's is explicit — "a cached snapshot so
// the billing/growth-points pages can show a real '$X/month'". Stored for
// these two pages to display, and dropped by both.
//
// ============ AND THE CURRENCY IS THE HALF THAT COULD DO HARM ==========
//
// This is the one place where the money is not the store's. provision-pricing
// creates every plan Price and every pack Price with currency "usd", so a shop
// selling in GBP still pays Genesis in dollars. A £ in front of a figure
// Stripe charges in $ is worse than showing nothing, so the constant and the
// provisioning script are compared here rather than trusted to stay in step.

let failures = 0;
let passes = 0;
const failed: string[] = [];

function assert(name: string, ok: boolean, detail = ""): void {
  if (ok) passes++;
  else {
    failures++;
    failed.push(`${name}${detail ? `  — ${detail}` : ""}`);
  }
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  — ${detail}` : ""}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
  assert(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function main(): void {
  console.log("\n--- the figure, formatted as money somebody pays ---\n");

  eq("a pack price reads as dollars and cents", formatPlatformPrice(999), "$9.99");
  eq("and keeps both decimal places on a round figure", formatPlatformPrice(5000), "$50.00");
  eq("a plan price says it recurs", formatPlatformMonthlyPrice(1999), "$19.99/month");

  // NULL IS AN ANSWER, NOT A ZERO. Plan.priceInCents is nullable by design
  // ("ships empty, populated later, never guessed"), and the pages render
  // nothing for it rather than "$0.00" — which would be a real claim about a
  // real charge.
  eq("a plan with no cached price formats to nothing", formatPlatformPrice(null), null);
  eq("  and not to a monthly nothing either", formatPlatformMonthlyPrice(null), null);
  eq("  undefined is the same answer", formatPlatformPrice(undefined), null);
  assert("  and zero is NOT null — a free price is a real price",
    formatPlatformPrice(0) === "$0.00", `${formatPlatformPrice(0)}`);

  console.log("\n--- the currency matches what Stripe is actually charging ---\n");

  const provisioning = readFileSync("scripts/provision-pricing.ts", "utf8");
  const currencies = [...provisioning.matchAll(/currency:\s*"([a-z]{3})"/g)].map((m) => m[1]);
  assert("provision-pricing sets a currency on every Price it creates",
    currencies.length >= 2, `${currencies.length} found`);
  assert("every one of them is the same currency",
    new Set(currencies).size === 1, JSON.stringify(currencies));
  eq("and it is the one these pages format with",
    currencies[0]?.toUpperCase(), PLATFORM_BILLING_CURRENCY);

  console.log("\n--- every purchasable pack carries a price to show ---\n");

  const packs = growthPointPackages();
  assert("there are packs offered at all", packs.length > 0, `${packs.length}`);
  for (const [key, pkg] of packs) {
    // A PACK IS OFFERED ONLY WHEN IT HAS A REAL stripePriceId, so every pack
    // that reaches the page is chargeable — and therefore must be able to say
    // what it charges. A priced button with no price is the defect; an
    // unpriced offer would be a worse one.
    assert(`${key} can state its price`, formatPlatformPrice(pkg.priceInCents) !== null,
      "offered for sale with no figure to show");
  }

  console.log("\n--- and both pages actually render it ---\n");

  // THE HELPER BEING RIGHT IS HALF OF IT. The figure was available and correct
  // for weeks; what was missing was any call site. Asserting the pages read it
  // is what stops this regressing to exactly where it started.
  const growth = readFileSync("app/dashboard/growth-points/page.tsx", "utf8");
  const billing = readFileSync("app/dashboard/billing/page.tsx", "utf8");

  assert("the Growth Point packs show a price", /formatPlatformPrice\(pkg\.priceInCents\)/.test(growth), "");
  assert("the plan cards show a monthly price",
    /formatPlatformMonthlyPrice\(plan\.priceInCents\)/.test(billing), "");
  assert("and neither reaches for the store's own currency",
    !/formatMoney\([^)]*store\.currency/.test(growth) && !/formatMoney\([^)]*store\.currency/.test(billing),
    "a GBP shop still pays Genesis in dollars");

  console.log(`\n${failures} failed, ${passes} passed`);
  if (failures > 0) {
    console.log("\nFAILED:");
    for (const line of failed) console.log(`  ${line}`);
    process.exitCode = 1;
  }
}

main();
