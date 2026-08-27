import type { DestinationAddress, ParcelDimensions, ShippingOption } from "../rates";
import {
  uspsFetch,
  uspsPlatformCredentials,
  UspsUnavailableError,
  type UspsPlatformCredentials,
} from "./client";
import {
  DOMESTIC_MAIL_CLASSES,
  cheapestPriceInCents,
  toRateRequest,
  toShippingOption,
  sortByPrice,
  addressFromUspsResponse,
  normalizeZip,
  type DomesticMailClass,
  type UspsAddressResponse,
  type UspsTotalRatesResponse,
} from "./mapping";

// RATES AND ADDRESSES, ON GENESIS'S OWN CREDENTIALS.
//
// The two things USPS lets a platform do with nothing asked of the merchant.
// Both take only an OAuth bearer token — no payment authorisation, no merchant
// account, no enrolment. That is what makes this the whole of phase one:
// every store gets live shipping rates and address checking the moment Genesis
// has credentials, and no merchant does anything at all.
//
// Buying the label is the part that needs the merchant, and it is not here.

/** One class's price, or an honest absence. */
async function priceOneClass(params: {
  credentials: UspsPlatformCredentials;
  originZip: string;
  destinationZip: string;
  parcel: ParcelDimensions;
  mailClass: DomesticMailClass;
  now: Date;
}): Promise<ShippingOption | null> {
  const body = toRateRequest({
    originZip: params.originZip,
    destinationZip: params.destinationZip,
    parcel: params.parcel,
    mailClass: params.mailClass,
    now: params.now,
    account: params.credentials.account,
  });

  const response = await uspsFetch<UspsTotalRatesResponse>({
    credentials: params.credentials,
    path: "/prices/v3/total-rates/search",
    body,
    now: params.now,
  });

  const amountInCents = cheapestPriceInCents(response);
  if (amountInCents === null) return null;
  return toShippingOption({ mailClass: params.mailClass, amountInCents, currency: "USD" });
}

export type UspsQuoteResult =
  | { ok: true; options: ShippingOption[] }
  | { ok: false; reason: "not_configured" | "unavailable" | "no_rates"; detail?: string };

/**
 * What USPS will carry this parcel for.
 *
 * ONE CALL PER CLASS, because the prices API prices a class at a time. Three
 * calls in parallel is the honest cost of offering a choice; the alternative is
 * quoting one service and calling it "shipping".
 *
 * A class that fails does not fail the quote. If Ground Advantage answers and
 * Priority Mail times out, the customer sees Ground Advantage rather than an
 * error — some real options beat no options. Only a total failure is a failure.
 */
export async function quoteUspsRates(params: {
  originZip: string;
  destination: DestinationAddress;
  parcel: ParcelDimensions;
  now?: Date;
}): Promise<UspsQuoteResult> {
  const credentials = uspsPlatformCredentials();
  if (!credentials) return { ok: false, reason: "not_configured" };

  // Domestic only. USPS international pricing is a different API with customs
  // requirements Genesis does not collect, and quoting it would be a promise
  // nothing behind here could keep.
  if (normalizeCountry(params.destination.country) !== "US") {
    return { ok: false, reason: "no_rates", detail: "USPS rating here is domestic only." };
  }

  const now = params.now ?? new Date();
  const settled = await Promise.allSettled(
    DOMESTIC_MAIL_CLASSES.map((mailClass) =>
      priceOneClass({
        credentials,
        originZip: params.originZip,
        destinationZip: params.destination.postalCode,
        parcel: params.parcel,
        mailClass,
        now,
      })
    )
  );

  const options: ShippingOption[] = [];
  let refused = 0;
  for (const result of settled) {
    if (result.status === "fulfilled") {
      if (result.value) options.push(result.value);
    } else {
      refused++;
    }
  }

  if (options.length === 0) {
    // Every class erroring is USPS being unreachable; every class answering
    // with nothing is a parcel USPS will not carry. The customer needs those
    // told apart — one is worth retrying and the other never will be.
    return refused === DOMESTIC_MAIL_CLASSES.length
      ? { ok: false, reason: "unavailable", detail: "USPS could not be reached." }
      : { ok: false, reason: "no_rates", detail: "USPS returned no services for this parcel." };
  }

  return { ok: true, options: sortByPrice(options) };
}

function normalizeCountry(country: string): string {
  const c = country.trim().toUpperCase();
  if (c === "USA" || c === "UNITED STATES" || c === "US") return "US";
  return c;
}

export type UspsAddressResult =
  | { ok: true; address: DestinationAddress }
  | { ok: false; reason: "not_configured" | "unavailable" | "undeliverable" };

/**
 * Is this a real, deliverable US address — and how does USPS write it?
 *
 * The authority behind every CASS-certified verifier, asked directly. What
 * comes back is a suggestion: the customer is shown both and chooses, exactly
 * as they already do for EasyPost's answer. Nothing is swapped silently.
 */
export async function verifyUspsAddress(
  entered: DestinationAddress,
  now: Date = new Date()
): Promise<UspsAddressResult> {
  const credentials = uspsPlatformCredentials();
  if (!credentials) return { ok: false, reason: "not_configured" };
  if (normalizeCountry(entered.country) !== "US") return { ok: false, reason: "not_configured" };

  try {
    const response = await uspsFetch<UspsAddressResponse>({
      credentials,
      path: "/addresses/v3/address",
      method: "GET",
      query: {
        streetAddress: entered.line1,
        secondaryAddress: entered.line2 ?? "",
        city: entered.city,
        state: entered.state ?? "",
        ZIPCode: normalizeZip(entered.postalCode),
      },
      now,
    });

    const address = addressFromUspsResponse(response, entered);
    // A response USPS could not confirm as deliverable is not a correction to
    // offer — it is an address nothing verified. See addressFromUspsResponse,
    // where DPV confirmation rather than a 200 is the test.
    return address ? { ok: true, address } : { ok: false, reason: "undeliverable" };
  } catch (error) {
    // Never throws outward. An address service hiccup must not stop somebody
    // buying something — the same rule verifyShippingAddress already follows.
    return {
      ok: false,
      reason: error instanceof UspsUnavailableError ? "unavailable" : "unavailable",
    };
  }
}
