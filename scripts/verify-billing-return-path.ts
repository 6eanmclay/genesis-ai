import { readFileSync } from "node:fs";
import { billingReturnUrl } from "@/lib/billing/returnPath";

// WHERE STRIPE SENDS THE OWNER BACK, AND WHICH BUSINESS THAT IS:
//
//   part of the code-only sweep — npx tsx scripts/run-code-suites.ts billing-return-path
//
// ============ THE DEFECT THIS HOLDS DOWN (2026-09-13) ==================
//
// Every Stripe redirect in lib/billing was a literal `/dashboard/billing` or
// `/dashboard/growth-points`. The legacy route resolves the account's ACTIVE
// business, and visiting /b/[slug] deliberately does not set that — so an
// owner who subscribed from a second business was returned to a different
// business's billing page immediately after paying, where it said that
// business isn't on a plan.
//
// The charge was never wrong: metadata carries the real storeId. Only the part
// the owner can see was.
//
// THE HELPER IS PURE AND LIVES ALONE FOR A REASON. lib/billing/stripeClient.ts
// builds a Stripe client at import time and throws with no API key, so nothing
// in checkout.ts can be called from this lane. Importing returnPath.ts costs
// nothing and exercises the real shipped function rather than a restatement of
// it — which is the failure this project has recorded five times: a suite that
// tests a copy of the rule passes while the rule is broken.
//
// AND THE LITERALS MUST NOT COME BACK. A correct helper that nothing calls is
// the same outage, so the source of both call sites is read for any surviving
// hardcoded legacy return path.

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

const BASE = "https://app.example.test";

function main(): void {
  console.log("\n--- the business the owner was operating on ---\n");

  eq(
    "subscribing from a business returns to that business",
    billingReturnUrl({ baseUrl: BASE, slug: "second-shop", page: "billing", query: "subscribe=success" }),
    `${BASE}/b/second-shop/billing?subscribe=success`,
  );
  eq(
    "and cancelling returns there too",
    billingReturnUrl({ baseUrl: BASE, slug: "second-shop", page: "billing", query: "subscribe=cancelled" }),
    `${BASE}/b/second-shop/billing?subscribe=cancelled`,
  );
  eq(
    "buying Growth Points returns to the business they were bought for",
    billingReturnUrl({ baseUrl: BASE, slug: "second-shop", page: "growth-points", query: "purchase=success" }),
    `${BASE}/b/second-shop/growth-points?purchase=success`,
  );
  eq(
    "the billing portal returns without inventing an outcome",
    billingReturnUrl({ baseUrl: BASE, slug: "second-shop", page: "billing" }),
    `${BASE}/b/second-shop/billing`,
  );

  console.log("\n--- and the legacy route still resolves the active business ---\n");

  // NOT A FALLBACK THAT PAPERS OVER A MISSING SLUG. /dashboard/billing is a
  // real route whose subject IS the active business, so resolving it there is
  // correct rather than tolerated — which is why the helper takes `undefined`
  // as a first-class input instead of requiring a slug.
  eq(
    "no slug means the legacy path, unchanged",
    billingReturnUrl({ baseUrl: BASE, slug: undefined, page: "billing", query: "subscribe=success" }),
    `${BASE}/dashboard/billing?subscribe=success`,
  );
  eq(
    "including for Growth Points",
    billingReturnUrl({ baseUrl: BASE, slug: undefined, page: "growth-points", query: "purchase=cancelled" }),
    `${BASE}/dashboard/growth-points?purchase=cancelled`,
  );

  console.log("\n--- the literals are gone from both call sites ---\n");

  const checkout = readFileSync("lib/billing/checkout.ts", "utf8");
  const portal = readFileSync("lib/billing/portal.ts", "utf8");

  for (const [label, source] of [["checkout.ts", checkout], ["portal.ts", portal]] as const) {
    // Template literals only — a comment naming the old path is history, not a
    // redirect, and this file and those both discuss it by name.
    const literals = source.match(/`\$\{baseUrl\}\/dashboard\//g) ?? [];
    assert(`${label} builds no return URL on the legacy path itself`,
      literals.length === 0, `${literals.length} hardcoded`);
    assert(`${label} calls the shared helper`,
      /billingReturnUrl\(/.test(source), "a helper nothing calls is the same outage");
  }

  // THE ACTIONS MUST ACTUALLY PASS THE SLUG THEY ALREADY HOLD. All three had
  // it in scope and dropped it, which is how the defect survived the
  // BUSINESS_CONTEXT.md Phase C migration that updated every screen.
  const billingActions = readFileSync("app/dashboard/billing/actions.ts", "utf8");
  const gpActions = readFileSync("app/dashboard/growth-points/actions.ts", "utf8");
  assert("the subscribe action carries the business into checkout",
    /createPlanSubscriptionCheckoutSession\([^)]*\{\s*slug\s*\}/.test(billingActions),
    "the action has the slug and must not drop it");
  assert("the portal action carries it too",
    /createBillingPortalSession\([^)]*\{\s*slug\s*\}/.test(billingActions), "");
  assert("and so does buying Growth Points",
    /createGrowthPointCheckoutSession\([^)]*\{\s*slug\s*\}/.test(gpActions), "");

  console.log(`\n${failures} failed, ${passes} passed`);
  if (failures > 0) {
    console.log("\nFAILED:");
    for (const line of failed) console.log(`  ${line}`);
    process.exitCode = 1;
  }
}

main();
