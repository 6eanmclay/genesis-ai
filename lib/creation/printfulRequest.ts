import { describeProviderError, redactSecrets } from "@/lib/integrations/providerError";

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
// The endpoint and the parameters we send both match, and always did. What was
// missing was never the request shape — it was any way to READ Printful's
// answer. See printfulFailure.

export const PRINTFUL_V2_BASE = "https://api.printful.com/v2";

/** The documented ceiling on `limit`. Sending more is a 400 by their spec. */
export const PRINTFUL_MAX_LIMIT = 100;

/**
 * WHICH SELLING REGION THE CATALOGUE IS READ FOR — and why it is sent at all.
 *
 * ============ PRINTFUL SAID SO, IN THOSE WORDS (2026-08-27) ==============
 *
 * With the body finally surfacing, the 400 read:
 *
 *     Printful creation.catalog failed (400): Selling region not found
 *
 * `selling_region_name` is documented as optional with a default of
 * "worldwide", so leaving it out should have been fine — and is not. Absent,
 * the beta resolves an empty region and cannot find it. Sending the default
 * explicitly is the difference between relying on a documented default and
 * stating the value.
 *
 * "worldwide" is one of Printful's own enum values, taken from their spec
 * rather than guessed: worldwide, north_america, canada, europe, spain,
 * latvia, uk, france, germany, australia, japan, new_zealand, italy, brazil,
 * southeast_asia, republic_of_korea, all.
 *
 * It is a CONSTANT rather than a setting because Genesis has no per-business
 * selling region yet. When it does, this becomes a parameter and everything
 * downstream keeps working — and until it does, hard-coding one is honest
 * where inventing a per-store answer would not be.
 */
export const PRINTFUL_SELLING_REGION = "worldwide";

/**
 * The catalogue endpoints that accept `selling_region_name`.
 *
 * `/catalog-products/{id}/catalog-variants` does NOT document it, and sending a
 * parameter an endpoint does not document is its own way of earning a 400 — so
 * this is a decision made per endpoint rather than a blanket append.
 */
export function withSellingRegion(path: string): string {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}selling_region_name=${PRINTFUL_SELLING_REGION}`;
}

/** Absolute URL for a v2 path such as `/catalog-products?limit=100`. */
export function printfulUrl(path: string): string {
  return `${PRINTFUL_V2_BASE}${path}`;
}

/**
 * The headers a v2 call carries.
 *
 * ============ THE STORE HEADER, ADDED AND THEN REMOVED (2026-08-27) =====
 *
 * `X-PF-Store-Id` was added here as a hypothesis: an OAuth token belongs to an
 * ACCOUNT rather than a store, lib/fulfillment/printful.ts sends it on its
 * store-scoped calls, and those work against real accounts. It was shipped with
 * the error-surfacing fix, and the error that came back named something else
 * entirely — "Selling region not found". Sending an explicit
 * selling_region_name=worldwide did not change that answer.
 *
 * So the header is removed, and this is the reasoning rather than a shrug:
 *
 *   - Printful documents the header for endpoints that REQUIRE store context.
 *     The catalogue is not one; it is the same for every account.
 *   - Supplying store context plausibly makes Printful resolve the selling
 *     region from the STORE instead of the query parameter — and a store with
 *     no selling region configured produces exactly "Selling region not found",
 *     while the explicit worldwide we send is ignored.
 *
 * That is a hypothesis too, and it is labelled as one. What is NOT a hypothesis
 * is that the header is not documented as required here, was added on my
 * reasoning rather than on evidence, and is the one variable that changed
 * between "unknown 400" and this. Removing it is the smaller claim.
 *
 * `storeScoped` exists rather than dropping the parameter, because a call that
 * genuinely acts for one store — placing an order, reading store products —
 * does need it. The shape mirrors authHeaders in lib/fulfillment/printful.ts.
 */
export function printfulHeaders(
  accessToken: string,
  printfulStoreId: number,
  storeScoped: boolean,
): Record<string, string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
  if (storeScoped) headers["X-PF-Store-Id"] = String(printfulStoreId);
  return headers;
}

/**
 * Whether a v2 path acts for one merchant's store.
 *
 * Every call the Creation Station makes is a catalogue read — the same blanks,
 * colours and print areas for every Printful account — so none of them is
 * store-scoped. Decided from the PATH rather than passed in by each call site,
 * so a new catalogue call cannot accidentally opt itself into store context.
 */
export function isStoreScoped(path: string): boolean {
  return !path.startsWith("/catalog-products");
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
export function printfulFailure(
  operation: string,
  status: number,
  bodyText: string,
  /** The v2 path that was requested. Omitted when there is nothing to add. */
  path?: string,
): string {
  const said = describeProviderError({ provider: "Printful", status, bodyText, stage: operation });
  if (!path) return said;

  // ============ WHAT WE SENT, ALONGSIDE WHAT THEY SAID ================
  //
  // Two rounds were spent not knowing whether a failure came from the build
  // that had the fix. The provider's answer alone cannot settle that; the
  // request can. So a failure now carries the path it was made against.
  //
  // SAFE TO SHOW: this is a catalogue path — an endpoint, a limit and a
  // selling region. No credential is in a v2 path, and the token and store id
  // live in headers, which are never included. redactSecrets is applied anyway
  // rather than relying on that staying true.
  return `${said} (asked for ${redactSecrets(path)})`;
}
