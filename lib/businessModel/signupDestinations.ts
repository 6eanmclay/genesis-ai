// CONNECT OR CREATE — WHERE SOMEBODY GOES IF THEY DO NOT HAVE THE ACCOUNT YET.
//
// ============ THE PHILOSOPHY THIS SERVES (2026-09-01) ==================
//
// Sean: "Don't make the customer figure out the next step. If they have it,
// connect it. If they don't, help them create it. If they don't need it, leave
// it alone. J4 should remove the friction rather than handing the customer a
// list of homework."
//
// ============ AND WHY THIS FILE IS SHORTER THAN THE CATALOGUE =========
//
// Sean, in the same message: "Do not invent URLs or rely on search-engine
// instructions... For providers without a reliable official signup destination,
// don't fabricate one; handle that honestly."
//
// So every URL below was FETCHED on 2026-09-01 and returned 200 following
// redirects. That is recorded here because a URL that merely looks right is
// precisely what this rule forbids, and a broken "Create an account" button is
// worse than no button — it is Genesis sending somebody somewhere and being
// wrong about it.
//
// TWO ARE DELIBERATELY NULL:
//
//   quickbooks   every candidate failed to resolve from here (connection
//                error, not a 404). Unverifiable is not the same as absent,
//                and the honest record is that we could not confirm one.
//   facebook     every candidate returned 400. Facebook rejects non-browser
//                requests, so a 400 tells us nothing about whether the URL is
//                right — which is exactly the case for not shipping it.
//
// A null renders as no Create button and a plain line saying we do not have a
// signup link, rather than a guess.
//
// ============ AND ONLY FOR SERVICES GENESIS CAN ACTUALLY CONNECT ======
//
// "If they don't need it, leave it alone." Sending somebody to create a Toast
// account that Genesis cannot connect afterwards would be handing them exactly
// the homework this idea exists to remove. The panel offers Create only where
// `connector` is non-null in the catalogue.

export interface SignupDestination {
  /** The official signup or account-creation page. */
  url: string;
  /**
   * The provider's own domain, asserted against the URL's host.
   *
   * Structural, and checked offline by the suite: it is what stops a later
   * edit pointing "Create a Stripe account" at somewhere that is not Stripe.
   */
  domain: string;
}

/** Keyed by CONNECTOR_CATALOG id. Absent or null means we have no verified destination. */
export const SIGNUP_DESTINATIONS: Record<string, SignupDestination | null> = {
  // ---- verified 2026-09-01, HTTP 200 following redirects ----------------
  "google-calendar": { url: "https://accounts.google.com/signup", domain: "google.com" },
  mailchimp: { url: "https://login.mailchimp.com/signup/", domain: "mailchimp.com" },
  instagram: { url: "https://www.instagram.com/accounts/emailsignup/", domain: "instagram.com" },
  tiktok: { url: "https://www.tiktok.com/signup", domain: "tiktok.com" },
  twilio: { url: "https://www.twilio.com/try-twilio", domain: "twilio.com" },
  printful: { url: "https://www.printful.com/auth/register", domain: "printful.com" },
  "square-pos": { url: "https://squareup.com/signup", domain: "squareup.com" },
  xero: { url: "https://www.xero.com/signup/", domain: "xero.com" },

  // ---- could not be verified, so deliberately not offered ---------------
  quickbooks: null,
  facebook: null,
};

/**
 * The signup destination for a service, or null.
 *
 * Null for anything unverified AND for anything Genesis cannot connect — a
 * Create button is only useful if connecting is possible afterwards.
 */
export function signupFor(catalogId: string, available: boolean): SignupDestination | null {
  if (!available) return null;
  return SIGNUP_DESTINATIONS[catalogId] ?? null;
}
