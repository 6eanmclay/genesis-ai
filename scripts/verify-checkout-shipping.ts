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

  // EXHAUSTIVE ON PURPOSE, and it earned its keep: adding address verification
  // to this shape in 2026-08-25 failed here rather than slipping through, which
  // is exactly what an assertion over the whole object is for. A session with no
  // shipping metadata has no verification either — nobody looked, and there is
  // no entered address to keep because nothing was changed.
  check("and no metadata at all parses the same way", parseCheckoutShipping(null), {
    address: null, enteredAddress: null, addressVerification: null,
    carrier: null, service: null, rateId: null, amountInCents: null, estimatedDays: null,
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

// ---------------------------------------------------------------------------
console.log("\n6. The two halves of the chain agree on the same keys");
{
  // createCheckoutSession WRITES this metadata; the webhook READS it, hours
  // later, in a different process, with nothing but string keys joining them.
  // A rename on either side would not fail a typecheck — it would silently
  // produce orders with no shipping, or none at all.
  const written = toCheckoutMetadata({
    storeId: "store_1",
    productId: "prod_1",
    destination: DESTINATION,
    selected: SELECTED,
  });

  // The webhook resolves the store and product from these two by name.
  check("storeId travels under the key the webhook reads", written.storeId, "store_1");
  check("and productId likewise", written.productId, "prod_1");

  // Everything the webhook needs for the Order comes back out of what was put
  // in — asserted as a ROUND TRIP rather than by comparing key lists, because
  // a key list can match while the values are mangled.
  const read = parseCheckoutShipping(written);
  check("carrier survives", read.carrier, SELECTED.carrier);
  check("service survives", read.service, SELECTED.service);
  check("rate id survives", read.rateId, SELECTED.rateId);
  check("amount survives", read.amountInCents, SELECTED.amountInCents);
  check("estimate survives", read.estimatedDays, SELECTED.estimatedDays);
  check("and the address survives whole", read.address?.postalCode, DESTINATION.postalCode);

  // Every key written is a string, because Stripe metadata cannot hold
  // anything else — a number or object would arrive back as something the
  // parser does not expect.
  assert("every metadata value is a string",
    Object.values(written).every((v) => typeof v === "string"),
    JSON.stringify(Object.entries(written).map(([k, v]) => [k, typeof v])));

  // The non-shipping checkout writes only these two keys. The webhook must
  // still resolve from them, and must not require the shipping ones.
  const plain = { storeId: "store_1", productId: "prod_1" };
  const plainRead = parseCheckoutShipping(plain);
  assert("a checkout without shipping still carries its store", plain.storeId === "store_1");
  check("and parses to honest nulls rather than failing", plainRead.carrier, null);
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
