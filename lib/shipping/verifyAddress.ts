import { resolveStoreEasyPostClient, type DestinationAddress } from "./rates";
import { verifyUspsAddress } from "./usps/quote";
import {
  isDomesticUs,
  verificationOutcomeOf,
  type AddressVerification,
  type EasyPostVerificationLike,
} from "./addressVerification";

// THE ONE NETWORK CALL, kept apart from every judgment it feeds.
//
// Split from addressVerification.ts because the checkout step is a client
// component: importing the pure helpers dragged this file's Prisma and EasyPost
// dependencies into the browser bundle, and Turbopack refused to build it
// ("Can't resolve 'dns'", via pg). The same pure-versus-plumbing split
// selectDueStoreIds already uses, for the same reason — the part with real
// semantics should be provable, and reachable, on its own.

/**
 * Verify one address — USPS first, on Genesis's own credentials.
 *
 * NEVER THROWS. An address service that is down, slow or unreachable must not
 * stop somebody buying something — checkout falls back to `not_checked`, which
 * the shipping step presents as "we could not check this" rather than as a
 * failure of the customer's address. Refusing a real order because a
 * third-party lookup hiccuped would be the worse outcome by a distance.
 */
export async function verifyShippingAddress(
  storeId: string,
  entered: DestinationAddress
): Promise<AddressVerification> {
  // CASS is a USPS certification and means nothing elsewhere. An international
  // address is returned unchecked rather than run through a check that does not
  // apply and "corrected" into something wrong.
  if (!isDomesticUs(entered)) {
    return {
      outcome: "not_checked",
      address: entered,
      reason: "Address checking is available for United States addresses.",
    };
  }

  // USPS IS THE AUTHORITY BEHIND EVERY CASS-CERTIFIED VERIFIER, and asking it
  // directly needs only credentials Genesis holds (2026-08-26). Before this,
  // checking an address required the MERCHANT to have connected EasyPost — so
  // for every store in production, nobody's address was ever checked.
  //
  // The outcome shape is identical either way, so the checkout step, the
  // correction prompt and the order record are all unchanged: the customer is
  // shown both addresses and chooses, and nothing is swapped silently.
  const usps = await verifyUspsAddress(entered);
  if (usps.ok) return verificationOutcomeOf(entered, toVerificationLike(usps.address));
  if (usps.reason === "undeliverable") {
    // USPS found the street but could not confirm this delivery point. That is
    // a real warning to a customer, not a provider failure to retry past.
    return {
      outcome: "unverifiable",
      address: entered,
      reason: "USPS couldn't confirm a delivery point at this address.",
    };
  }

  // Not configured, or USPS could not answer. EasyPost still runs below for any
  // store that connected one — unchanged, and now a fallback rather than the
  // only route.
  const resolved = await resolveStoreEasyPostClient(storeId);
  if (!resolved.ok) {
    return {
      outcome: "not_checked",
      address: entered,
      reason: "This store has no address service connected.",
    };
  }

  try {
    // The same account and the same address shape rating already sends. `verify`
    // rather than `verify_strict`: strict returns an error instead of a result,
    // which would collapse "we found a correction" and "we could not check"
    // into one indistinguishable failure.
    const address = await resolved.client.Address.create({
      verify: ["delivery"],
      street1: entered.line1,
      street2: entered.line2 ?? undefined,
      city: entered.city,
      state: entered.state ?? undefined,
      zip: entered.postalCode,
      country: entered.country,
      name: entered.name ?? undefined,
    });
    return verificationOutcomeOf(entered, address as EasyPostVerificationLike);
  } catch {
    return {
      outcome: "not_checked",
      address: entered,
      reason: "The address service could not be reached.",
    };
  }
}

/**
 * A USPS-confirmed address in the shape verificationOutcomeOf already judges.
 *
 * ONE COMPARISON FOR BOTH CARRIERS. verificationOutcomeOf decides whether an
 * answer is a correction, an exact match or unusable, and that judgment — plus
 * the "nothing changes without the customer choosing" rule it enforces — must
 * not be written a second time per provider. So the USPS answer is adapted to
 * its input rather than the judgment being duplicated.
 *
 * `success: true` because reaching here already means USPS confirmed delivery;
 * see addressFromUspsResponse, which returns null unless DPV confirmed it.
 */
function toVerificationLike(address: DestinationAddress): EasyPostVerificationLike {
  return {
    street1: address.line1,
    street2: address.line2 ?? null,
    city: address.city,
    state: address.state ?? null,
    zip: address.postalCode,
    country: address.country,
    verifications: { delivery: { success: true, errors: [] } },
  };
}
