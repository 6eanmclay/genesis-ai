import {
  DOMESTIC_MAIL_CLASSES,
  uspsRateId,
  mailClassFromRateId,
  poundsFromOunces,
  toRateRequest,
  normalizeZip,
  cheapestPriceInCents,
  toShippingOption,
  sortByPrice,
  addressFromUspsResponse,
} from "@/lib/shipping/usps/mapping";
import { carrierAvailability, shippingGapFor } from "@/lib/shipping/carriers";
import { uspsPlatformCredentials, uspsIsConfigured, resetUspsTokenCache } from "@/lib/shipping/usps/client";
import type { DestinationAddress, ParcelDimensions } from "@/lib/shipping/rates";
import { readFileSync } from "fs";
import { join } from "path";

// USPS AS A NATIVE GENESIS INTEGRATION:
//
//   npx tsx scripts/verify-usps-native.ts
//
// Standalone — no database, no network, no USPS account.
//
// WHAT THIS CAN AND CANNOT PROVE, said first because it is the honest limit.
// Genesis has no USPS credentials yet, so not one live call has been made
// against apis.usps.com. Everything below is the pure half: how a Genesis
// parcel becomes a USPS question, how a USPS answer becomes a checkout option,
// and which carrier answers for which store. The network half is a thin wrapper
// over exactly these functions and is UNVERIFIED until credentials exist.
//
// THE DEFECT SHAPE THIS EXISTS FOR is a wrong price that does not error.
// Genesis stores ounces; USPS prices in pounds. A parcel sent in the wrong unit
// returns a confident, plausible, sixteen-times-wrong rate that a real customer
// pays. So units get more assertions here than anything else.

let failures = 0;
function assert(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  -- ${detail}` : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(name, ok, ok ? "" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const read = (...p: string[]) => codeOnly(readFileSync(join(process.cwd(), ...p), "utf8"));

const NOW = new Date("2026-08-26T15:00:00.000Z");
const PARCEL: ParcelDimensions = { weightOz: 20, lengthIn: 10, widthIn: 8, heightIn: 4 };
const DESTINATION: DestinationAddress = {
  name: "Sarah Chen",
  line1: "1600 Pearl St",
  line2: "Apt 4",
  city: "Boulder",
  state: "CO",
  postalCode: "80302",
  country: "US",
};

console.log("\n=== 1. Ounces are not pounds ===\n");

// THE ASSERTION THAT MATTERS MOST IN THIS FILE.
eq("20 oz is 1.25 lb", poundsFromOunces(20), 1.25);
eq("16 oz is exactly 1 lb", poundsFromOunces(16), 1);
eq("8 oz is half a pound", poundsFromOunces(8), 0.5);
eq("3 oz rounds to hundredths rather than repeating", poundsFromOunces(3), 0.19);
assert("CONTROL: the weight is converted, never passed through",
  poundsFromOunces(PARCEL.weightOz) !== PARCEL.weightOz,
  "sending 20 into a pounds field quotes a 20 lb parcel and overcharges by 16x");

const request = toRateRequest({
  originZip: "94104",
  destinationZip: DESTINATION.postalCode,
  parcel: PARCEL,
  mailClass: "PRIORITY_MAIL",
  now: NOW,
  account: null,
});
eq("the request carries pounds", request.weight, 1.25);
eq("and inches unchanged", [request.length, request.width, request.height], [10, 8, 4]);
eq("origin ZIP", request.originZIPCode, "94104");
eq("destination ZIP", request.destinationZIPCode, "80302");
eq("the mail class asked for", request.mailClass, "PRIORITY_MAIL");
eq("mailing date in USPS's format", request.mailingDate, "2026-08-26");

// COMMERCIAL, NOT RETAIL. Retail is the post-office-counter price; quoting it
// would overcharge every customer of every store.
eq("commercial pricing, which is what a business pays", request.priceType, "COMMERCIAL");

// ZIP+4 is rejected by the rate request's ZIP fields.
eq("ZIP+4 is trimmed to ZIP5", normalizeZip("80302-1234"), "80302");
eq("and whitespace with it", normalizeZip("  94104 "), "94104");

// An account is sent when known and omitted when not, rather than filled with
// a placeholder — USPS's docs do not say whether commercial pricing needs one.
assert("no account means no account fields at all",
  !("accountType" in request) && !("accountNumber" in request));
const withAccount = toRateRequest({
  originZip: "94104", destinationZip: "80302", parcel: PARCEL,
  mailClass: "PRIORITY_MAIL", now: NOW,
  account: { accountType: "EPS", accountNumber: "1000388717" },
});
eq("and an account is passed through when there is one",
  [withAccount.accountType, withAccount.accountNumber], ["EPS", "1000388717"]);

console.log("\n=== 2. A chosen service survives without carrying a price ===\n");

// THE RULE THE WHOLE CHECKOUT DEPENDS ON: the browser names a service, never an
// amount. EasyPost hands out an opaque rate id; USPS has none, so the id is the
// class — which the server re-derives and re-quotes rather than trusting.
for (const mailClass of DOMESTIC_MAIL_CLASSES) {
  eq(`${mailClass} round-trips through its rate id`,
    mailClassFromRateId(uspsRateId(mailClass)), mailClass);
}
eq("an EasyPost rate id is not mistaken for USPS", mailClassFromRateId("rate_abc123"), null);
eq("nor is a made-up class", mailClassFromRateId("usps:FREE_SHIPPING"), null);
eq("nor an empty string", mailClassFromRateId(""), null);
assert("CONTROL: and the id contains no money",
  !/\d+\.\d\d/.test(uspsRateId("PRIORITY_MAIL")),
  "a price in the id would be a price the browser could edit");

console.log("\n=== 3. What USPS said becomes what the customer sees ===\n");

eq("the cheapest option is the quoted one",
  cheapestPriceInCents({ rateOptions: [{ totalPrice: 8.02 }, { totalPrice: 5.84 }] }), 584);
eq("totalPrice wins over totalBasePrice, because the customer pays the total",
  cheapestPriceInCents({ rateOptions: [{ totalBasePrice: 4.59, totalPrice: 5.84 }] }), 584);
eq("base price is used when there is no total",
  cheapestPriceInCents({ rateOptions: [{ totalBasePrice: 4.59 }] }), 459);
eq("dollars become cents", cheapestPriceInCents({ rateOptions: [{ totalPrice: 12.3 }] }), 1230);

// NULL, NEVER ZERO. A zero here becomes free shipping on a real order.
eq("no options is null", cheapestPriceInCents({ rateOptions: [] }), null);
eq("no response at all is null", cheapestPriceInCents(null), null);
eq("a malformed option is null", cheapestPriceInCents({ rateOptions: [{}] }), null);
eq("a zero price is refused rather than quoted",
  cheapestPriceInCents({ rateOptions: [{ totalPrice: 0 }] }), null);
assert("because a zero would be free shipping somebody actually paid for",
  cheapestPriceInCents({ rateOptions: [{ totalPrice: 0 }] }) === null);

const option = toShippingOption({ mailClass: "PRIORITY_MAIL", amountInCents: 892, currency: "USD" });
eq("the carrier is named", option.carrier, "USPS");
eq("the service reads as USPS's own name", option.service, "Priority Mail");
eq("the amount is carried", option.amountInCents, 892);
eq("and the label is built from real values", option.label, "USPS Priority Mail");
// A price API returns a price, not a delivery date. Inventing "2 days" from a
// class name would be a promise to a customer that nothing checked.
eq("no delivery estimate is invented", option.estimatedDays, null);

const sorted = sortByPrice([
  toShippingOption({ mailClass: "PRIORITY_MAIL_EXPRESS", amountInCents: 3200, currency: "USD" }),
  toShippingOption({ mailClass: "USPS_GROUND_ADVANTAGE", amountInCents: 640, currency: "USD" }),
  toShippingOption({ mailClass: "PRIORITY_MAIL", amountInCents: 892, currency: "USD" }),
]);
eq("cheapest first, so the default selection is the cheapest real option",
  sorted.map((o) => o.amountInCents), [640, 892, 3200]);

console.log("\n=== 4. An address is confirmed, not merely spelled ===\n");

const confirmed = addressFromUspsResponse(
  {
    address: { streetAddress: "1600 PEARL ST", secondaryAddress: "APT 4", city: "BOULDER", state: "CO", ZIPCode: "80302", ZIPPlus4: "1234" },
    additionalInfo: { DPVConfirmation: "Y" },
  },
  DESTINATION
);
eq("a confirmed address comes back standardised", confirmed?.line1, "1600 PEARL ST");
eq("with the unit kept", confirmed?.line2, "APT 4");
eq("and ZIP5, not ZIP+4", confirmed?.postalCode, "80302");
assert("because four extra digits are not what the customer typed",
  confirmed?.postalCode === "80302",
  "showing ZIP+4 back invites a customer to reject a correction that added nothing they care about");
eq("the customer's own name is preserved", confirmed?.name, "Sarah Chen");

// DPV IS THE TEST, NOT THE 200. USPS will standardise the spelling of a street
// that exists while telling you the specific delivery point does not.
eq("a street that exists but a delivery point that does not is refused",
  addressFromUspsResponse(
    { address: { streetAddress: "1600 PEARL ST", city: "BOULDER", ZIPCode: "80302" }, additionalInfo: { DPVConfirmation: "N" } },
    DESTINATION
  ), null);
eq("a partial match on the unit is refused too",
  addressFromUspsResponse(
    { address: { streetAddress: "1600 PEARL ST", city: "BOULDER", ZIPCode: "80302" }, additionalInfo: { DPVConfirmation: "D" } },
    DESTINATION
  ), null);
eq("a response with no confirmation at all is refused",
  addressFromUspsResponse({ address: { streetAddress: "1600 PEARL ST", city: "BOULDER", ZIPCode: "80302" } }, DESTINATION), null);
eq("and an empty response is refused", addressFromUspsResponse(null, DESTINATION), null);
eq("as is a confirmed response missing its street",
  addressFromUspsResponse({ address: { city: "BOULDER", ZIPCode: "80302" }, additionalInfo: { DPVConfirmation: "Y" } }, DESTINATION), null);

console.log("\n=== 5. Who answers for which store ===\n");

// THE POINT OF THE WHOLE DIRECTION. EasyPost was not a provider in Genesis, it
// WAS shipping — and across sixteen production businesses, none had connected
// one, so the entire feature was reachable by nobody.
eq("with USPS configured, a store with no EasyPost still gets rates",
  carrierAvailability({ uspsConfigured: true, easypostConnected: false }).rates, "USPS_PLATFORM");
eq("and address checking",
  carrierAvailability({ uspsConfigured: true, easypostConnected: false }).addresses, "USPS_PLATFORM");
assert("which is the whole change: nothing is asked of the merchant",
  carrierAvailability({ uspsConfigured: true, easypostConnected: false }).rates !== "NONE");

eq("USPS is preferred even when EasyPost is connected, because it costs the merchant nothing",
  carrierAvailability({ uspsConfigured: true, easypostConnected: true }).rates, "USPS_PLATFORM");
eq("without USPS, a connected EasyPost still answers — it is not deprecated",
  carrierAvailability({ uspsConfigured: false, easypostConnected: true }).rates, "EASYPOST_MERCHANT");
eq("and with neither, nobody does",
  carrierAvailability({ uspsConfigured: false, easypostConnected: false }).rates, "NONE");

// LABELS ARE THE HONEST PART. USPS's Labels API needs the MERCHANT's Enterprise
// Payment Account, USPS Ship enrolment and an authorisation granted in USPS's
// own portal — none of which Genesis can do for them.
eq("Genesis's own credentials cannot buy a label",
  carrierAvailability({ uspsConfigured: true, easypostConnected: false }).labels, "NONE");
eq("only a merchant's own connected account can",
  carrierAvailability({ uspsConfigured: true, easypostConnected: true }).labels, "EASYPOST_MERCHANT");
assert("so no dead Buy Label button is ever offered",
  carrierAvailability({ uspsConfigured: true, easypostConnected: false }).labels === "NONE",
  "claiming a label could be bought would fail on a real paid order");

eq("a store that can quote but not post is told the smaller, specific thing",
  shippingGapFor(carrierAvailability({ uspsConfigured: true, easypostConnected: false }))?.includes("buying postage"),
  true);
eq("a store that can do neither is told shipping is not connected",
  shippingGapFor(carrierAvailability({ uspsConfigured: false, easypostConnected: false }))?.includes("isn't connected"),
  true);
eq("and a store where everything works is told nothing at all",
  shippingGapFor(carrierAvailability({ uspsConfigured: false, easypostConnected: true })), null);

console.log("\n=== 6. Inert until configured ===\n");

// DEPLOYING THIS MUST NOT CHANGE A SINGLE EXISTING CHECKOUT. With no
// credentials set, every path falls back to exactly what it did before.
const savedId = process.env.USPS_CLIENT_ID;
const savedSecret = process.env.USPS_CLIENT_SECRET;
delete process.env.USPS_CLIENT_ID;
delete process.env.USPS_CLIENT_SECRET;
resetUspsTokenCache();
eq("no credentials means not configured", uspsIsConfigured(), false);
eq("and no credentials object", uspsPlatformCredentials(), null);

process.env.USPS_CLIENT_ID = "test-client";
process.env.USPS_CLIENT_SECRET = "test-secret";
resetUspsTokenCache();
eq("both halves present means configured", uspsIsConfigured(), true);
eq("production is the default environment",
  uspsPlatformCredentials()?.baseUrl, "https://apis.usps.com");
process.env.USPS_USE_TEST_ENVIRONMENT = "1";
eq("and the test environment is one variable away",
  uspsPlatformCredentials()?.baseUrl, "https://apis-tem.usps.com");
delete process.env.USPS_USE_TEST_ENVIRONMENT;

// HALF A CREDENTIAL IS NOT A CREDENTIAL.
delete process.env.USPS_CLIENT_SECRET;
eq("an id with no secret is not configured", uspsIsConfigured(), false);
process.env.USPS_CLIENT_SECRET = "test-secret";

// A malformed account is dropped rather than sent.
process.env.USPS_ACCOUNT_NUMBER = "1000388717";
process.env.USPS_ACCOUNT_TYPE = "NONSENSE";
eq("an account type USPS does not have is discarded", uspsPlatformCredentials()?.account, null);
process.env.USPS_ACCOUNT_TYPE = "EPS";
eq("and a real one is kept",
  uspsPlatformCredentials()?.account, { accountType: "EPS", accountNumber: "1000388717" });
delete process.env.USPS_ACCOUNT_NUMBER;
delete process.env.USPS_ACCOUNT_TYPE;

if (savedId) process.env.USPS_CLIENT_ID = savedId; else delete process.env.USPS_CLIENT_ID;
if (savedSecret) process.env.USPS_CLIENT_SECRET = savedSecret; else delete process.env.USPS_CLIENT_SECRET;
resetUspsTokenCache();

console.log("\n=== 7. EasyPost is demoted, never removed ===\n");

const rates = read("lib", "shipping", "rates.ts");
assert("USPS is asked first",
  rates.indexOf("await quoteUspsRates(") < rates.indexOf("await resolveStoreEasyPostClient("),
  "call sites, not imports");
assert("and EasyPost still runs when USPS cannot",
  /resolveStoreEasyPostClient\(params\.storeId\)/.test(rates),
  "a merchant who connected EasyPost keeps every carrier it brokers");

const verify = read("lib", "shipping", "verifyAddress.ts");
// CALL SITES, not imports. The first version of this compared raw indexOf and
// failed because the import list happens to name EasyPost first — a red for the
// wrong reason, which is the same defect as a green for one.
assert("address checking asks USPS first too",
  verify.indexOf("await verifyUspsAddress(entered)") <
    verify.indexOf("await resolveStoreEasyPostClient(storeId)"),
  "compared where each is CALLED, since the imports are ordered independently");
assert("and both carriers are judged by ONE function",
  /verificationOutcomeOf\(entered, toVerificationLike/.test(verify) &&
    /verificationOutcomeOf\(entered, address as EasyPostVerificationLike\)/.test(verify),
  "two judgments would be two chances to disagree about the same address");

const gate = read("lib", "shipping", "checkoutShipping.ts");
assert("the storefront gate asks for a rate source, not a vendor",
  /availability\.rates === "NONE"/.test(gate) &&
    !/easypost\?\.status !== "CONNECTED"\) return false/.test(gate),
  "requiring EasyPost by name is what made this false for every store in production");
assert("CONTROL: and Stripe is still required",
  /stripe\?\.status !== "CONNECTED"\) return false/.test(gate),
  "a chosen service has to become a Stripe shipping line; without it the buy fails");

const client = read("lib", "shipping", "usps", "client.ts");
assert("the OAuth token is cached against the clock, not assumed",
  /expiresAt - EXPIRY_SKEW_MS > now\.getTime\(\)/.test(client));
assert("and a rejected token is dropped rather than replayed",
  /status === 401[\s\S]{0,200}cached = null/.test(client));

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} assertion(s) FAILED.`}`);
console.log("\nNOTE: the network half is UNVERIFIED — Genesis has no USPS credentials yet,");
console.log("so no live call has been made against apis.usps.com.");
process.exit(failures === 0 ? 0 : 1);
