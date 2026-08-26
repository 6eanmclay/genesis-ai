import {
  verificationOutcomeOf,
  verificationStateOf,
  sameAddress,
  isDomesticUs,
  type EasyPostVerificationLike,
} from "@/lib/shipping/addressVerification";
import { parseCheckoutShipping, toCheckoutMetadata } from "@/lib/shipping/checkoutShipping";
import type { DestinationAddress } from "@/lib/shipping/rates";
import { readFileSync } from "fs";
import { join } from "path";

// IS THIS ADDRESS REAL, AND DID THE CUSTOMER CHOOSE IT:
//
//   npx tsx scripts/verify-address-verification.ts
//
// Standalone — every judgment in this feature is pure, so it is provable
// against recorded provider payloads without an account. The one network call
// is a thin wrapper around them.
//
// THE FAILURE MODE THIS EXISTS FOR IS A SILENT SWAP. A customer types their
// address, a database says it should be written differently, and software
// replaces one with the other without asking. When that is right it is
// invisible; when it is wrong the parcel goes to a real house that is not
// theirs. So most of what follows asserts that nothing changes without an
// explicit choice.

let failures = 0;
function assert(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(name, ok, ok ? "" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const read = (...p: string[]) => codeOnly(readFileSync(join(process.cwd(), ...p), "utf8"));

const entered: DestinationAddress = {
  name: "Sean",
  line1: "417 Montgomery Street",
  line2: null,
  city: "San Francisco",
  state: "CA",
  postalCode: "94104",
  country: "US",
};

const ok = (over: Partial<EasyPostVerificationLike> = {}): EasyPostVerificationLike => ({
  street1: "417 MONTGOMERY ST",
  street2: null,
  city: "SAN FRANCISCO",
  state: "CA",
  zip: "94104",
  country: "US",
  verifications: { delivery: { success: true, errors: [] } },
  ...over,
});

console.log("\n=== 1. What the provider said becomes an outcome ===\n");

const corrected = verificationOutcomeOf(entered, ok());
eq("a standardised address is a CORRECTION, not a silent swap", corrected.outcome, "corrected");
assert("and the address in hand is still the customer's",
  corrected.outcome === "corrected" && corrected.address.line1 === "417 Montgomery Street",
  "nothing changes until they choose");
assert("with the suggestion carried alongside it",
  corrected.outcome === "corrected" && corrected.suggestion.line1 === "417 MONTGOMERY ST");

const identical = verificationOutcomeOf(entered, ok({ street1: "417 Montgomery Street", city: "San Francisco" }));
eq("an address already written correctly is simply verified", identical.outcome, "verified");

const failed = verificationOutcomeOf(entered, ok({
  verifications: { delivery: { success: false, errors: [{ message: "House number not found" }] } },
}));
eq("a delivery failure is unverifiable", failed.outcome, "unverifiable");
assert("carrying the provider's own words",
  failed.outcome === "unverifiable" && failed.reason === "House number not found",
  "that tells a customer which box to look at; a sentence we invented would not");

const noReason = verificationOutcomeOf(entered, ok({
  verifications: { delivery: { success: false, errors: [] } },
}));
assert("and a reasonless failure still says something useful",
  noReason.outcome === "unverifiable" && noReason.reason.length > 0);

eq("no response at all is NOT CHECKED, not unverifiable",
  verificationOutcomeOf(entered, null).outcome, "not_checked");
assert("because 'we looked and it failed' and 'nobody looked' are different things",
  verificationOutcomeOf(entered, null).outcome !== "unverifiable",
  "collapsing them would warn a customer about an address nothing had examined");

console.log("\n=== 2. What counts as the same address ===\n");

assert("case and spacing do not make it different",
  sameAddress(entered, { ...entered, line1: "  417 montgomery street  " }));
assert("a real standardisation does",
  !sameAddress(entered, { ...entered, line1: "417 MONTGOMERY ST" }),
  "the customer should see and accept that, not have it papered over");
assert("a different ZIP does", !sameAddress(entered, { ...entered, postalCode: "94105" }));
assert("and a missing unit number does",
  !sameAddress(entered, { ...entered, line2: "Apt 4" }));

console.log("\n=== 3. Domestic only, deliberately ===\n");

assert("US is domestic", isDomesticUs(entered));
assert("so is USA", isDomesticUs({ ...entered, country: "USA" }));
assert("and the spelled-out form", isDomesticUs({ ...entered, country: "United States" }));
assert("Canada is not", !isDomesticUs({ ...entered, country: "CA" }));
assert("CONTROL: and the state CA does not make it so",
  !isDomesticUs({ ...entered, country: "CA", state: "CA" }),
  "country is the field that decides, not the state");

// SPLIT, and the split itself is asserted: the pure module must stay free of
// server imports, because the checkout step is a client component and pulling
// the EasyPost half in dragged pg into the browser bundle.
const pure = read("lib", "shipping", "addressVerification.ts");
assert("the pure module imports nothing that reaches a database or a provider",
  !/from "\.\/rates"/.test(pure.replace(/import type[^;]+;/g, "")),
  "a client component imports these helpers; a value import here breaks the build");
const verifier = read("lib", "shipping", "verifyAddress.ts");
assert("a non-US address is returned unchecked rather than 'corrected'",
  /if \(!isDomesticUs\(entered\)\)[\s\S]{0,200}not_checked/.test(verifier),
  "CASS is a USPS certification and means nothing elsewhere");
assert("and the verifier never throws",
  /catch \{[\s\S]{0,200}not_checked/.test(verifier),
  "an address service hiccup must not stop somebody buying something");

console.log("\n=== 4. How it is recorded ===\n");

eq("verified records verified", verificationStateOf("verified"), "verified");
eq("an accepted correction also records verified", verificationStateOf("corrected"), "verified");
eq("unverifiable records unverified", verificationStateOf("unverifiable"), "unverified");
eq("and not_checked keeps its own name", verificationStateOf("not_checked"), "not_checked");
assert("so 'confirmed deliverable' is never confused with 'nobody looked'",
  verificationStateOf("unverifiable") !== verificationStateOf("not_checked"));

console.log("\n=== 5. Both addresses survive the trip to the order ===\n");

const suggestion: DestinationAddress = { ...entered, line1: "417 MONTGOMERY ST", city: "SAN FRANCISCO" };
const metadata = toCheckoutMetadata({
  storeId: "s1", productId: "p1",
  destination: suggestion,
  selected: { rateId: "r1", carrier: "USPS", service: "Priority", amountInCents: 850, estimatedDays: 2 },
  enteredAddress: entered,
  addressVerification: "verified",
});
const parsed = parseCheckoutShipping(metadata);
eq("the address shipped to is the standardised one", parsed.address?.line1, "417 MONTGOMERY ST");
eq("and what the customer typed is kept", parsed.enteredAddress?.line1, "417 Montgomery Street");
eq("with how it was arrived at", parsed.addressVerification, "verified");

const unchanged = parseCheckoutShipping(
  toCheckoutMetadata({
    storeId: "s1", productId: "p1", destination: entered,
    selected: { rateId: "r1", carrier: "USPS", service: "Priority", amountInCents: 850, estimatedDays: 2 },
    enteredAddress: null,
    addressVerification: "verified",
  })
);
eq("nothing is stored twice when nothing changed", unchanged.enteredAddress, null);
eq("CONTROL: and the address itself is still there", unchanged.address?.line1, "417 Montgomery Street");

eq("a session with no shipping metadata parses to nulls",
  parseCheckoutShipping({}).addressVerification, null);
eq("and a verification state we did not write is discarded",
  parseCheckoutShipping({ shippingAddressVerification: "definitely-fine" }).addressVerification, null);
eq("malformed entered-address JSON loses the audit copy, not the order",
  parseCheckoutShipping({ shippingAddressEntered: "{not json" }).enteredAddress, null);

console.log("\n=== 6. The customer is asked, never overridden ===\n");

const step = read("app", "store", "[slug]", "ship", "[productId]", "ShippingStep.tsx");
assert("a correction is offered as a question",
  /Did you mean this address\?/.test(step));
assert("with both addresses shown side by side",
  /You entered:/.test(step),
  "the customer can only recognise their own address if they can see both");
assert("accepting is an explicit choice",
  /Use this address/.test(step) && /Keep what I entered/.test(step));
assert("an unverifiable address warns rather than blocks",
  /We couldn&apos;t confirm this address/.test(step) && /Use this address anyway/.test(step),
  "a new-build address is a real case, and the customer may know what the database does not");

const actions = read("app", "store", "[slug]", "actions.ts");
assert("checkout stops and asks before quoting a correction",
  /verification\.outcome === "corrected" && !acknowledged/.test(actions));
assert("and before quoting an unverifiable address",
  /verification\.outcome === "unverifiable" && !acknowledged/.test(actions));
assert("CONTROL: once acknowledged it proceeds",
  /addressAcknowledged/.test(actions),
  "the customer's choice is what releases it, not a timeout or a retry");

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} assertion(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
