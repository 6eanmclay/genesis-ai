import type { DestinationAddress, ParcelDimensions, ShippingOption } from "../rates";
import { OUNCES_PER_POUND } from "../packagedWeight";

// TURNING A GENESIS PARCEL INTO A USPS QUESTION, AND A USPS ANSWER BACK.
//
// PURE. No network, no database, no clock beyond what is passed in. Everything
// here is provable against recorded USPS payloads, which matters more than
// usual: Genesis has no USPS credentials yet, so the network half cannot be
// exercised at all until one exists. The judgment half can, and is.
//
// WHY USPS DIRECTLY RATHER THAN THROUGH EASYPOST. EasyPost requires every
// merchant to open their own account and paste an API key before Genesis can
// quote a single rate — and across all 16 businesses in production, not one has
// done it. Rates and address checking on USPS need only Genesis's own
// credentials, so every store gets them without the merchant doing anything.
//
// UNITS ARE THE EASY THING TO GET WRONG, so they are stated once here:
//   Genesis stores ounces (Product.weightOz) and inches.
//   USPS takes POUNDS and inches.
// A parcel sent in ounces against a pounds field is quoted as sixteen times its
// weight, which does not error — it just returns a wrong, plausible price.

/**
 * The domestic classes a small merchant actually chooses between.
 *
 * Deliberately not every class USPS sells. Bound Printed Matter, Library Mail
 * and Media Mail have eligibility rules about what may be inside the box that
 * Genesis cannot check, and quoting a rate the merchant is not entitled to use
 * is worse than not offering it.
 */
export const DOMESTIC_MAIL_CLASSES = [
  "USPS_GROUND_ADVANTAGE",
  "PRIORITY_MAIL",
  "PRIORITY_MAIL_EXPRESS",
] as const;

export type DomesticMailClass = (typeof DOMESTIC_MAIL_CLASSES)[number];

/** How each class reads to a customer. USPS's own names, not invented ones. */
const SERVICE_NAMES: Record<DomesticMailClass, string> = {
  USPS_GROUND_ADVANTAGE: "Ground Advantage",
  PRIORITY_MAIL: "Priority Mail",
  PRIORITY_MAIL_EXPRESS: "Priority Mail Express",
};

/**
 * The id a chosen USPS service travels under.
 *
 * EasyPost hands out an opaque rate id; USPS has no equivalent, because a USPS
 * price is a pure function of the parcel and the class. So the id IS the class,
 * which makes it re-derivable: the server re-quotes at checkout and matches on
 * this rather than trusting any amount the browser sent. That is the same rule
 * lib/shipping/checkoutShipping.ts already enforces for EasyPost rates, kept
 * identical so one checkout path serves both carriers.
 */
export function uspsRateId(mailClass: DomesticMailClass): string {
  return `usps:${mailClass}`;
}

/** The class back out of a rate id, or null if this id is not USPS's. */
export function mailClassFromRateId(rateId: string): DomesticMailClass | null {
  const [prefix, mailClass] = rateId.split(":");
  if (prefix !== "usps") return null;
  return (DOMESTIC_MAIL_CLASSES as readonly string[]).includes(mailClass)
    ? (mailClass as DomesticMailClass)
    : null;
}

export interface UspsRateRequest {
  originZIPCode: string;
  destinationZIPCode: string;
  weight: number;
  length: number;
  width: number;
  height: number;
  mailClass: DomesticMailClass;
  priceType: "COMMERCIAL" | "RETAIL";
  mailingDate: string;
  accountType?: "EPS" | "PERMIT";
  accountNumber?: string;
}

/** Ounces to pounds, at the precision USPS prices on. */
export function poundsFromOunces(weightOz: number): number {
  // Rounded to hundredths rather than passed raw: a float like 1.0625 lb is
  // fine, but 20/16 repeating is not something to hand a pricing API.
  return Math.round((weightOz / OUNCES_PER_POUND) * 100) / 100;
}

/** The date USPS prices against — today, in the format it wants. */
export function mailingDateFor(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * One rate request, for one class.
 *
 * ZIP ONLY, both ends. USPS prices domestic parcels on the two postcodes and
 * the box; sending the rest of the address would be handing over a customer's
 * street address for a question that does not need it.
 */
export function toRateRequest(params: {
  originZip: string;
  destinationZip: string;
  parcel: ParcelDimensions;
  mailClass: DomesticMailClass;
  now: Date;
  account?: { accountType: "EPS" | "PERMIT"; accountNumber: string } | null;
}): UspsRateRequest {
  return {
    originZIPCode: normalizeZip(params.originZip),
    destinationZIPCode: normalizeZip(params.destinationZip),
    weight: poundsFromOunces(params.parcel.weightOz),
    length: params.parcel.lengthIn,
    width: params.parcel.widthIn,
    height: params.parcel.heightIn,
    mailClass: params.mailClass,
    // COMMERCIAL is what a business pays. Retail is the post-office-counter
    // price and quoting it would overcharge every customer.
    priceType: "COMMERCIAL",
    mailingDate: mailingDateFor(params.now),
    // Present only when Genesis has an account to price against. USPS's own
    // examples always include one; whether it is required for plain commercial
    // pricing is not stated, so it is sent when known and omitted when not,
    // rather than inventing a number to fill the field.
    ...(params.account
      ? { accountType: params.account.accountType, accountNumber: params.account.accountNumber }
      : {}),
  };
}

/** ZIP5. USPS rejects ZIP+4 in the rate request's ZIP fields. */
export function normalizeZip(zip: string): string {
  return zip.trim().slice(0, 5);
}

/** The shape USPS returns from /prices/v3/total-rates/search. */
export interface UspsTotalRatesResponse {
  rateOptions?: {
    totalBasePrice?: number;
    totalPrice?: number;
    rates?: {
      description?: string;
      price?: number;
      mailClass?: string;
      productName?: string;
    }[];
  }[];
}

/**
 * The cheapest option USPS returned for one class, in cents.
 *
 * NULL RATHER THAN ZERO when nothing usable came back. A zero here would become
 * free shipping on a real order — the same reasoning parseCheckoutShipping uses
 * for refusing to default a missing amount.
 */
export function cheapestPriceInCents(response: UspsTotalRatesResponse | null | undefined): number | null {
  const options = response?.rateOptions ?? [];
  const prices: number[] = [];
  for (const option of options) {
    // totalPrice includes extra services; totalBasePrice is postage alone.
    // The customer pays the total, so that is what is quoted.
    const price = typeof option.totalPrice === "number" ? option.totalPrice : option.totalBasePrice;
    if (typeof price === "number" && Number.isFinite(price) && price > 0) prices.push(price);
  }
  if (prices.length === 0) return null;
  return Math.round(Math.min(...prices) * 100);
}

/**
 * A priced class, as the checkout list wants it.
 *
 * DELIVERY ESTIMATES ARE NULL, and that is deliberate rather than unfinished.
 * The prices API returns a price, not a delivery date; USPS publishes those
 * through a separate Service Standards API. Inventing "2 days" from a class
 * name would be a promise to a customer that nothing checked.
 */
export function toShippingOption(params: {
  mailClass: DomesticMailClass;
  amountInCents: number;
  currency: string;
}): ShippingOption {
  const service = SERVICE_NAMES[params.mailClass];
  return {
    rateId: uspsRateId(params.mailClass),
    carrier: "USPS",
    service,
    amountInCents: params.amountInCents,
    estimatedDays: null,
    label: `USPS ${service}`,
  };
}

/** Cheapest first, so the default selection is the cheapest real option. */
export function sortByPrice(options: ShippingOption[]): ShippingOption[] {
  return [...options].sort((a, b) => a.amountInCents - b.amountInCents);
}

// ---------------------------------------------------------------------------
// ADDRESSES
// ---------------------------------------------------------------------------

/** The shape USPS returns from /addresses/v3/address. */
export interface UspsAddressResponse {
  address?: {
    streetAddress?: string;
    secondaryAddress?: string;
    city?: string;
    state?: string;
    ZIPCode?: string;
    ZIPPlus4?: string;
  };
  additionalInfo?: {
    DPVConfirmation?: string;
  };
}

/**
 * USPS's answer as a Genesis address, or null when it could not confirm one.
 *
 * DPV CONFIRMATION IS THE TEST, not the presence of a response. USPS will
 * happily standardise the spelling of a street that exists while telling you,
 * in DPVConfirmation, that the specific delivery point does not. "Y" is a
 * confirmed deliverable address; "D" and "S" mean the primary number matched
 * but the apartment did not, which for a parcel is not good enough; anything
 * else is a miss.
 */
export function addressFromUspsResponse(
  response: UspsAddressResponse | null | undefined,
  entered: DestinationAddress
): DestinationAddress | null {
  const address = response?.address;
  if (!address) return null;
  if (response?.additionalInfo?.DPVConfirmation !== "Y") return null;
  if (!address.streetAddress || !address.city || !address.ZIPCode) return null;

  return {
    name: entered.name ?? null,
    line1: address.streetAddress,
    line2: address.secondaryAddress || null,
    city: address.city,
    state: address.state ?? null,
    // ZIP5 only. ZIP+4 is more precise and is not what the customer typed;
    // showing it back as "their" address invites them to reject a correction
    // that only added four digits.
    postalCode: address.ZIPCode,
    country: "US",
  };
}
