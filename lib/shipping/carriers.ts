import { prisma } from "@/lib/prisma";
import { uspsIsConfigured } from "./usps/client";

// WHICH CARRIER ANSWERS, AND WHY THAT STOPPED BEING "EASYPOST, ALWAYS".
//
// Until now EasyPost was not a shipping provider in Genesis — it WAS shipping.
// A store without its own EasyPost account got no rates, no address checking
// and no label, and the merchant's way in was: go to easypost.com, open an
// account, generate an API key, come back and paste it. Across sixteen
// businesses in production, none ever did. The feature was fully built and
// reachable by nobody.
//
// USPS changes the shape rather than the provider. Rates and address checking
// need only credentials GENESIS holds, so they work for every store with the
// merchant doing nothing at all. EasyPost stays exactly as it is — a second
// provider a merchant may connect for other carriers, never a prerequisite.
//
// ONE RULE DECIDES EVERYTHING BELOW: a merchant is never asked to do something
// Genesis can do for them. Where USPS genuinely requires the merchant — buying
// postage from their own account — that is named, explained and asked for once.

/** Who can answer a given shipping question for a given store. */
export type CarrierSource =
  /** Genesis's own USPS credentials. Nothing asked of the merchant. */
  | "USPS_PLATFORM"
  /** The merchant's own EasyPost account, if they connected one. */
  | "EASYPOST_MERCHANT"
  /** Nobody. */
  | "NONE";

export interface CarrierAvailability {
  /** Who will quote rates at checkout. */
  rates: CarrierSource;
  /** Who will check a customer's address. */
  addresses: CarrierSource;
  /**
   * Who can buy a label.
   *
   * USPS_PLATFORM never appears here, and that is the honest part: the Labels
   * API needs the MERCHANT's Enterprise Payment Account, USPS Ship enrolment
   * and an authorisation they grant in USPS's own portal. Genesis cannot buy
   * postage on a merchant's behalf until they have done that, and pretending
   * otherwise would put a dead button on a paid order.
   */
  labels: CarrierSource;
}

/**
 * What this store can actually do today.
 *
 * PURE, given the two facts it needs. Split from the database read so the
 * decision is provable without one — the same split parcelForProduct and
 * verificationOutcomeOf already use.
 */
export function carrierAvailability(params: {
  uspsConfigured: boolean;
  easypostConnected: boolean;
}): CarrierAvailability {
  // USPS FIRST FOR RATES AND ADDRESSES, deliberately. Both are free to the
  // merchant and instant; preferring a provider that requires them to open an
  // account would be choosing the harder path for no gain.
  const readOnly: CarrierSource = params.uspsConfigured
    ? "USPS_PLATFORM"
    : params.easypostConnected
      ? "EASYPOST_MERCHANT"
      : "NONE";

  return {
    rates: readOnly,
    addresses: readOnly,
    // Labels are the merchant's own postage either way. EasyPost is the only
    // route Genesis can complete today; the USPS route needs their enrolment.
    labels: params.easypostConnected ? "EASYPOST_MERCHANT" : "NONE",
  };
}

/** The same question, against real rows. */
export async function carrierAvailabilityFor(storeId: string): Promise<CarrierAvailability> {
  const easypost = await prisma.storeIntegration.findUnique({
    where: { storeId_provider: { storeId, provider: "EASYPOST" } },
    select: { status: true },
  });
  return carrierAvailability({
    uspsConfigured: uspsIsConfigured(),
    easypostConnected: easypost?.status === "CONNECTED",
  });
}

/**
 * What the owner is told about shipping on this store, in their own terms.
 *
 * Returns null when everything works, because a working thing needs no notice.
 */
export function shippingGapFor(availability: CarrierAvailability): string | null {
  if (availability.rates === "NONE") {
    return "Shipping isn't connected, so customers can't be quoted a delivery price.";
  }
  if (availability.labels === "NONE") {
    // Rates work; only postage is missing. Said as the specific, smaller thing
    // it is rather than as "shipping is broken".
    return "Customers can be quoted shipping, but buying postage through Genesis needs a USPS or EasyPost account connected.";
  }
  return null;
}
