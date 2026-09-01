// WHERE TO SEND A MERCHANT WHEN STRIPE OWNS THE ANSWER.
//
// ============ WHAT WAS CHECKED, NOT ASSUMED (2026-09-01) ===============
//
// Sean: "Don't invent a management URL or assume an API capability exists.
// Check the installed Stripe SDK/API capabilities first."
//
// So the first question was whether Stripe can mint a management link for us.
// It can — `accounts.createLoginLink` — and the SDK's own doc comment rules it
// out for this platform in one sentence:
//
//   "You can only create login links for accounts that use the Express
//    Dashboard and are connected to your platform."
//
// Genesis uses Connect STANDARD: lib/integrations/stripe.ts completes an OAuth
// handoff and stores `token.stripe_user_id` with `scope: "read_write"`. A
// Standard account has its OWN Stripe login and its own dashboard. Calling
// createLoginLink against one returns an error, so nothing here calls it — and
// that is a fact from the SDK rather than a guess about the API.
//
// ============ SO THESE ARE STRIPE'S OWN SETTINGS PATHS =================
//
// Plain, unparameterised dashboard paths, which is the form that works for any
// merchant signed in to their own Stripe account. Deliberately NOT the
// account-scoped `dashboard.stripe.com/<acct_id>/…` form: that shape is widely
// used and this codebase has no evidence for it, and a link that 404s on a
// money screen is worse than one extra click.
//
// The account id is shown BESIDE these links instead, so a merchant with more
// than one Stripe account can confirm they are looking at the right one — the
// problem the account-scoped URL would have solved, solved with a fact we
// actually have.
//
// ============ AND GENESIS DOES NOT RECREATE ANY OF IT ==================
//
// Sean: "Genesis should link out to Stripe for management rather than trying
// to recreate Stripe's account-management UI." Bank details, payout schedule,
// identity and verification all live at Stripe, are governed by Stripe's own
// compliance rules, and change under regulations Genesis does not track.

export interface StripeManagementLink {
  /** What the merchant is going to do there. */
  label: string;
  url: string;
  /** Why Genesis does not do this itself. */
  because: string;
}

const DASHBOARD = "https://dashboard.stripe.com";

/**
 * The things a merchant has to do at Stripe, and where.
 *
 * Ordered by what somebody looking at a payout screen actually wants: the bank
 * account the money lands in, then when it goes, then who Stripe thinks they
 * are.
 */
export const STRIPE_MANAGEMENT_LINKS: StripeManagementLink[] = [
  {
    label: "Bank account and payout settings",
    url: `${DASHBOARD}/settings/payouts`,
    because:
      "Bank details are held by Stripe under its own verification rules. Genesis shows " +
      "the last four digits of where a payout went and never holds the account itself.",
  },
  {
    label: "Business and account information",
    url: `${DASHBOARD}/settings/account`,
    because:
      "Your legal entity, address and verification documents belong to Stripe's " +
      "compliance process, not to Genesis.",
  },
  {
    label: "Everything else in Stripe",
    url: `${DASHBOARD}/`,
    because: "Payments, disputes, tax settings and reporting all live at Stripe.",
  },
];

/** The one link for a merchant who just wants to get to Stripe. */
export const STRIPE_DASHBOARD_URL = `${DASHBOARD}/`;

/**
 * Whether Genesis could mint a one-click login link for this account.
 *
 * Always false for Standard, which is every account Genesis connects. Exported
 * as a function rather than a constant so the reason travels with the answer,
 * and so the day Genesis supports Express this is where that becomes true
 * rather than a link quietly changing meaning.
 */
export function canMintLoginLink(accountType: string | null): boolean {
  // `express` only. `standard` accounts have their own dashboard login;
  // `custom` accounts have no dashboard at all.
  return accountType === "express";
}
