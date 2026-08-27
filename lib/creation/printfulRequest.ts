import { describeProviderError } from "@/lib/integrations/providerError";

// HOW A PRINTFUL v2 CATALOGUE CALL IS SHAPED — pure, and therefore provable.
//
// ============ WHY THIS IS ITS OWN FILE ==================================
//
// lib/creation/provider.ts is `server-only`: it reads encrypted credentials, so
// importing it outside Next is a build error. That is right, and it also meant
// nothing about the request could be tested — the URL, the headers and the
// failure message were built inside a closure no suite could reach.
//
// That is not a small gap. This is the only Printful v2 caller in the codebase,
// and it had never once run against a live account (the OAuth handoff was
// broken until 931de79), so its first real execution was a 400 in front of the
// owner. Everything here is the half with real semantics; provider.ts keeps the
// half that needs a database and a token. Same split as aliexpressProtocol vs
// aliexpressClient.
//
// ============ VERIFIED AGAINST PRINTFUL'S PUBLISHED SPEC ================
//
// developers.printful.com, v2:
//   GET https://api.printful.com/v2/catalog-products
//   limit   integer [1..100], default 20
//   offset  integer >= 0, default 0
// The endpoint and the parameters we send both match. What was missing was the
// store header — see printfulHeaders.

export const PRINTFUL_V2_BASE = "https://api.printful.com/v2";

/** The documented ceiling on `limit`. Sending more is a 400 by their spec. */
export const PRINTFUL_MAX_LIMIT = 100;

/** Absolute URL for a v2 path such as `/catalog-products?limit=100`. */
export function printfulUrl(path: string): string {
  return `${PRINTFUL_V2_BASE}${path}`;
}

/**
 * The headers every v2 call carries.
 *
 * ============ THE STORE HEADER (2026-08-27) ===========================
 *
 * `X-PF-Store-Id` was absent here and present in lib/fulfillment/printful.ts,
 * whose store-scoped calls have worked against real accounts since onboarding
 * v2. An OAuth token belongs to an account, not a store, so Printful has to be
 * told which store a call acts for — and a request it cannot attribute is
 * rejected rather than guessed at.
 *
 * It is safe on an endpoint that does not need it: the value is the store id
 * Printful itself returned for this token at connect time, so it can only ever
 * agree with the token.
 */
export function printfulHeaders(accessToken: string, printfulStoreId: number): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "X-PF-Store-Id": String(printfulStoreId),
  };
}

/**
 * What a failed call is allowed to say.
 *
 * This used to be `Printful ${operation} failed (${status})` with the body
 * dropped — so the only thing that explains a rejection was read by nobody, and
 * the owner got a number. describeProviderError keeps the provider's own error
 * name and description and redacts anything token-shaped, which matters because
 * this string is durable: it reaches ExecutionLog and the owner's screen.
 */
export function printfulFailure(operation: string, status: number, bodyText: string): string {
  return describeProviderError({ provider: "Printful", status, bodyText, stage: operation });
}
