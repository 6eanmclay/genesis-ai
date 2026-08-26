import { resolveStoreEasyPostClient, type DestinationAddress } from "./rates";
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
 * Verify one address against the store's own EasyPost account.
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
