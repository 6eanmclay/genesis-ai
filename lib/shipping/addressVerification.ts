import type { DestinationAddress } from "./rates";

// IS THIS ADDRESS REAL, AND IS THIS HOW IT IS WRITTEN?
//
// Checkout has always accepted whatever the customer typed. Every field being
// populated is not the same as the parcel arriving: a transposed house number
// or a wrong ZIP passes every required-field check and then fails in a sorting
// facility, days later, at the merchant's expense.
//
// THIS USES THE ACCOUNT THAT IS ALREADY THERE. Rating already sends this exact
// address to EasyPost as a Shipment's `to_address`; asking for verification is
// the same account, the same request shape, and no new provider, dependency or
// bill. EasyPost's verification is CASS-certified against USPS data.
//
// DOMESTIC US ONLY, deliberately. CASS is a USPS certification and means
// nothing outside the United States. An international address is returned
// unverified rather than run through a check that does not apply to it and
// "corrected" into something wrong.
//
// PURE, AND CLIENT-SAFE. Every judgment lives here and nothing in this file
// imports a database or a provider client — the checkout step is a client
// component and importing the EasyPost half pulled `pg` into the browser
// bundle, which Turbopack refused outright ("Can't resolve 'dns'"). The network
// call lives in verifyAddress.ts, which only the server imports.
//
// NOTHING HERE DECIDES FOR THE CUSTOMER. The verifier reports; the checkout
// step asks. A standardised address is a suggestion the customer accepts, and
// an unverifiable one is a warning they acknowledge — never a silent swap of
// the address somebody typed for one they never saw.

/** What came back, and what the customer should be asked. */
export type AddressVerification =
  /** Deliverable, and written exactly as the postal service writes it. */
  | { outcome: "verified"; address: DestinationAddress }
  /** Deliverable, but the postal service writes it differently. */
  | { outcome: "corrected"; address: DestinationAddress; suggestion: DestinationAddress }
  /**
   * Could not be confirmed deliverable.
   *
   * Carries the reason the provider gave, because "we could not find that
   * street" and "the ZIP does not match the city" send a customer to different
   * parts of the form.
   */
  | { outcome: "unverifiable"; address: DestinationAddress; reason: string }
  /**
   * Verification did not run at all — no connection, or not a US address.
   *
   * DISTINCT FROM `unverifiable`, and the distinction matters: one means the
   * address was checked and failed, the other that nobody looked. Collapsing
   * them would warn a customer about an address nothing had examined.
   */
  | { outcome: "not_checked"; address: DestinationAddress; reason: string };

/** The shape EasyPost returns on a verified address. */
export interface EasyPostVerificationLike {
  street1?: string | null;
  street2?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  country?: string | null;
  verifications?: {
    delivery?: {
      success?: boolean | null;
      errors?: { message?: string | null }[] | null;
    } | null;
  } | null;
}

/** US, in the forms a checkout form actually produces. */
export function isDomesticUs(address: DestinationAddress): boolean {
  const country = (address.country ?? "").trim().toUpperCase();
  return country === "US" || country === "USA" || country === "UNITED STATES";
}

/**
 * Are these the same address, ignoring how they are written?
 *
 * Case and surrounding whitespace only. Deliberately NOT smarter than that: if
 * the provider changed "Street" to "ST" that is a real standardisation the
 * customer should see and accept, not a difference to paper over. The whole
 * point of showing a suggestion is that the customer recognises their own
 * address in it.
 */
export function sameAddress(a: DestinationAddress, b: DestinationAddress): boolean {
  const norm = (v: string | null | undefined) => (v ?? "").trim().toUpperCase();
  return (
    norm(a.line1) === norm(b.line1) &&
    norm(a.line2) === norm(b.line2) &&
    norm(a.city) === norm(b.city) &&
    norm(a.state) === norm(b.state) &&
    norm(a.postalCode) === norm(b.postalCode)
  );
}

/**
 * A provider response and the address that was sent, to an outcome.
 *
 * Pure, and this is where every judgment lives — so "what would we tell the
 * customer" is provable against recorded payloads without an account, the same
 * split `toShipment` already uses for tracking.
 */
export function verificationOutcomeOf(
  entered: DestinationAddress,
  response: EasyPostVerificationLike | null
): AddressVerification {
  if (!response) {
    return { outcome: "not_checked", address: entered, reason: "No response from the address service." };
  }

  const delivery = response.verifications?.delivery;
  const errors = (delivery?.errors ?? [])
    .map((e) => (e?.message ?? "").trim())
    .filter((m) => m.length > 0);

  if (delivery?.success !== true) {
    return {
      outcome: "unverifiable",
      address: entered,
      // The provider's own words. "House number not found" tells a customer
      // exactly which box to look at; a sentence this file invented would not.
      reason: errors[0] ?? "This address could not be confirmed as deliverable.",
    };
  }

  // Verified. What came back may still be written differently.
  const standardized: DestinationAddress = {
    name: entered.name ?? null,
    line1: response.street1?.trim() || entered.line1,
    line2: response.street2?.trim() || null,
    city: response.city?.trim() || entered.city,
    state: response.state?.trim() || (entered.state ?? null),
    postalCode: response.zip?.trim() || entered.postalCode,
    country: response.country?.trim() || entered.country,
  };

  return sameAddress(entered, standardized)
    ? { outcome: "verified", address: standardized }
    : { outcome: "corrected", address: entered, suggestion: standardized };
}

/**
 * How an outcome should be recorded against the order.
 *
 * `verified` and `corrected` both end with a CASS-standardised address once the
 * customer has accepted the suggestion, so both record "verified". The two
 * unchecked cases record what actually happened rather than being flattened
 * into a single "no".
 */
export type AddressVerificationState = "verified" | "unverified" | "not_checked";

export function verificationStateOf(outcome: AddressVerification["outcome"]): AddressVerificationState {
  if (outcome === "verified" || outcome === "corrected") return "verified";
  if (outcome === "unverifiable") return "unverified";
  return "not_checked";
}
