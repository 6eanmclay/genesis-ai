import { parcelForProduct, toShippingOptions } from "@/lib/shipping/rates";
import { readFileSync } from "fs";
import { join } from "path";

// Live shipping rates at checkout — the pure decisions, proved with fixtures.
// No database, no EasyPost account, no network:
//
//   npx tsx scripts/verify-shipping-rates.ts
//
// The rule these defend: a real customer is about to be charged this number.
// A guessed weight, a rate shown at $0, or an invented delivery promise are all
// worse than declining to quote.

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}

function assert(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

// ---------------------------------------------------------------------------
console.log("\n1. A product with no weight cannot be rated");
{
  check("no weight at all", parcelForProduct({ weightOz: null, lengthIn: 6, widthIn: 4, heightIn: 2 }), null);
  check("zero weight is not a weight", parcelForProduct({ weightOz: 0, lengthIn: 6, widthIn: 4, heightIn: 2 }), null);
  check("negative weight is refused", parcelForProduct({ weightOz: -3, lengthIn: null, widthIn: null, heightIn: null }), null);
  // Declining is the point: a guessed weight becomes a real charge on a real
  // customer's card.
  assert("null means 'cannot rate', never 'weighs nothing'", parcelForProduct({ weightOz: null, lengthIn: null, widthIn: null, heightIn: null }) === null);
}

// ---------------------------------------------------------------------------
console.log("\n2. Weight is never invented; box dimensions may be defaulted");
{
  check(
    "real weight is used exactly",
    parcelForProduct({ weightOz: 12.5, lengthIn: 9, widthIn: 6, heightIn: 3 }),
    { weightOz: 12.5, lengthIn: 9, widthIn: 6, heightIn: 3 }
  );
  // Weight is the number that moves the price. Dimensions rarely do for
  // domestic services, so a weighed product with no box still gets quoted.
  check(
    "missing dimensions fall back, weight does not",
    parcelForProduct({ weightOz: 4, lengthIn: null, widthIn: null, heightIn: 0 }),
    { weightOz: 4, lengthIn: 6, widthIn: 4, heightIn: 2 }
  );
}

// ---------------------------------------------------------------------------
console.log("\n3. Real EasyPost rates become checkout options");
{
  const fixture = JSON.parse(
    readFileSync(join(process.cwd(), "scripts/fixtures/easypost-rates.json"), "utf8")
  ) as { rates: unknown[] };
  const options = toShippingOptions(fixture.rates as never);

  check("all four usable rates survive", options.length, 4);
  check("cheapest first", options.map((o) => o.amountInCents), [745, 892, 1235, 2840]);
  check("carrier and service carried through", [options[0].carrier, options[0].service], ["USPS", "Ground Advantage"]);
  check("camelCase service names are made readable", options[1].service, "Priority Mail");
  check(
    "a rate with an estimate says so",
    options[1].label,
    "USPS Priority Mail — $8.92, about 2 days"
  );
  check(
    "a rate without one promises nothing",
    options[3].label,
    "UPS Next Day Air — $28.40"
  );
  check("and carries a null estimate rather than a guess", options[3].estimatedDays, null);
  check("rate ids are preserved for purchase", options[0].rateId, "rate_ground_advantage");
}

// ---------------------------------------------------------------------------
console.log("\n4. Unusable rates are dropped, never shown at zero");
{
  const options = toShippingOptions([
    { id: "rate_ok", carrier: "USPS", service: "Priority", rate: "9.10", delivery_days: 2 },
    { id: "rate_zero", carrier: "USPS", service: "Free?", rate: "0.00" },
    { id: "rate_nan", carrier: "USPS", service: "Broken", rate: "not-a-number" },
    { id: "rate_missing", carrier: "USPS", service: "NoPrice", rate: null },
    { id: null, carrier: "USPS", service: "NoId", rate: "5.00" },
    { id: "rate_nocarrier", carrier: null, service: "Orphan", rate: "5.00" },
  ] as never);
  check("only the real one survives", options.map((o) => o.rateId), ["rate_ok"]);
  check("priced correctly in cents", options[0].amountInCents, 910);
}

// ---------------------------------------------------------------------------
console.log("\n5. Money is converted exactly");
{
  const options = toShippingOptions([
    { id: "a", carrier: "USPS", service: "A", rate: "7.45" },
    { id: "b", carrier: "USPS", service: "B", rate: "10.00" },
    { id: "c", carrier: "USPS", service: "C", rate: "12.345" },
  ] as never);
  check("cents are integers, rounded at the boundary", options.map((o) => o.amountInCents), [745, 1000, 1235]);
  assert("every amount is an integer", options.every((o) => Number.isInteger(o.amountInCents)));
}

// ---------------------------------------------------------------------------
console.log("\n6. No rates is an empty list, not a fabricated option");
{
  check("nothing in, nothing out", toShippingOptions([]), []);
  check("all-unusable in, nothing out", toShippingOptions([{ id: "x", carrier: "USPS", service: "S", rate: "0" }] as never), []);
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
