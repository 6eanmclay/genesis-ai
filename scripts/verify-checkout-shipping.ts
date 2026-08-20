import { toCheckoutMetadata, parseCheckoutShipping } from "@/lib/shipping/checkoutShipping";

// Customer-chosen shipping through checkout — the pure round trip.
// No database, no Stripe, no EasyPost:
//
//   npx tsx scripts/verify-checkout-shipping.ts
//
// Two properties matter most here. A checkout that did NOT use live shipping
// must be completely unaffected — it produces no metadata and parses to all
// nulls, so the order it creates is byte-identical to before this feature
// existed. And nothing about the money may be inferred: a missing or malformed
// amount is null, never a default.

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

const DESTINATION = {
  name: "Sarah Chen",
  line1: "1600 Pearl St",
  line2: "Apt 4",
  city: "Boulder",
  state: "CO",
  postalCode: "80302",
  country: "US",
};

const SELECTED = {
  rateId: "rate_priority",
  carrier: "USPS",
  service: "Priority Mail",
  amountInCents: 892,
  estimatedDays: 2,
};

// ---------------------------------------------------------------------------
console.log("\n1. The chosen service survives the round trip through Stripe");
{
  const metadata = toCheckoutMetadata({ storeId: "store_1", productId: "prod_1", destination: DESTINATION, selected: SELECTED });
  const parsed = parseCheckoutShipping(metadata);

  check("carrier", parsed.carrier, "USPS");
  check("service", parsed.service, "Priority Mail");
  check("rate id, so the exact quote can be bought later", parsed.rateId, "rate_priority");
  check("amount in cents", parsed.amountInCents, 892);
  check("delivery estimate", parsed.estimatedDays, 2);
  check("and the address the customer actually typed", parsed.address, {
    name: "Sarah Chen",
    line1: "1600 Pearl St",
    line2: "Apt 4",
    city: "Boulder",
    state: "CO",
    postalCode: "80302",
    country: "US",
  });
  // Stripe caps metadata values at 500 characters.
  assert("every metadata value fits Stripe's limit", Object.values(metadata).every((v) => v.length <= 500));
}

// ---------------------------------------------------------------------------
console.log("\n2. A checkout without live shipping is completely unaffected");
{
  // This is what every existing store's checkout looks like today.
  const legacy = { storeId: "store_1", productId: "prod_1" };
  const parsed = parseCheckoutShipping(legacy);
  check("no address from metadata — Stripe's own is used instead", parsed.address, null);
  check("no carrier", parsed.carrier, null);
  check("no service", parsed.service, null);
  check("no rate id", parsed.rateId, null);
  check("no amount, so nothing is written to the order", parsed.amountInCents, null);
  check("no estimate", parsed.estimatedDays, null);

  check("and no metadata at all parses the same way", parseCheckoutShipping(null), {
    address: null, carrier: null, service: null, rateId: null, amountInCents: null, estimatedDays: null,
  });
}

// ---------------------------------------------------------------------------
console.log("\n3. Money is never inferred");
{
  check("a missing amount is null", parseCheckoutShipping({ shippingCarrier: "USPS" }).amountInCents, null);
  check("an unparseable amount is null", parseCheckoutShipping({ shippingAmountInCents: "eight dollars" }).amountInCents, null);
  check("an empty amount is null", parseCheckoutShipping({ shippingAmountInCents: "" }).amountInCents, null);
  // Free shipping is a real, chosen outcome and must survive.
  check("but a genuine zero survives", parseCheckoutShipping({ shippingAmountInCents: "0" }).amountInCents, 0);
  check("and a negative one does not", parseCheckoutShipping({ shippingAmountInCents: "-500" }).amountInCents, null);
}

// ---------------------------------------------------------------------------
console.log("\n4. A half-written address is no address");
{
  const missingCity = JSON.stringify({ line1: "1600 Pearl St", postalCode: "80302", country: "US" });
  check("missing city is rejected whole", parseCheckoutShipping({ shippingAddress: missingCity }).address, null);
  const missingZip = JSON.stringify({ line1: "1600 Pearl St", city: "Boulder", country: "US" });
  check("missing postcode is rejected whole", parseCheckoutShipping({ shippingAddress: missingZip }).address, null);
  check("malformed JSON is rejected", parseCheckoutShipping({ shippingAddress: "{not json" }).address, null);
  // A partial address would produce a label to nowhere; null makes the webhook
  // fall back to Stripe's own collected address instead.
  assert("nothing partial is ever returned", parseCheckoutShipping({ shippingAddress: missingCity }).address === null);
}

// ---------------------------------------------------------------------------
console.log("\n5. An estimate is carried only when the carrier gave one");
{
  const noEstimate = toCheckoutMetadata({
    storeId: "s", productId: "p", destination: DESTINATION,
    selected: { ...SELECTED, estimatedDays: null },
  });
  assert("no estimate means no metadata key at all", !("shippingEstDays" in noEstimate));
  check("and it parses back as null", parseCheckoutShipping(noEstimate).estimatedDays, null);
  check("a zero-day estimate is not a promise", parseCheckoutShipping({ shippingEstDays: "0" }).estimatedDays, null);
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
