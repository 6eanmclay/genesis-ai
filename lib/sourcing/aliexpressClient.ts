import "server-only";

import {
  ALIEXPRESS_GATEWAY,
  buildSignedParams,
  readFailure,
  readProducts,
  type AliexpressFailure,
  type AliexpressProduct,
} from "./aliexpressProtocol";

// THE ONLY PLACE THAT TALKS TO ALIEXPRESS, AND THE ONLY PLACE THAT HOLDS THE
// SECRET.
//
// ============ WHERE THE CREDENTIALS LIVE, AND WHY THERE =====================
//
// AliExpress issues ONE app key and secret to Genesis, not one per merchant.
// That makes them platform credentials of exactly the same kind as USPS's — a
// single pair, held by the deployment, never asked of an owner and never
// belonging to a store. So they follow the same rule USPS follows: server
// environment variables, read at call time.
//
// `server-only` at the top is the enforcement, not the intention. It is a build
// error — not a lint warning, not a convention — for any client component to
// import this file, however indirectly. The pure half of this integration lives
// in ./aliexpressProtocol.ts precisely so that everything testable can be
// reached without pulling the secret's neighbourhood into a bundle.
//
// The secret is never sent to a browser, never written to the repository, and
// never appears in a response body. It is used for one thing: computing an MD5
// on this side of the network.

/** Read at call time, so a deployment that gains the variables starts working. */
export function aliexpressCredentials(): { appKey: string; appSecret: string } | null {
  const appKey = process.env.ALIEXPRESS_APP_KEY?.trim();
  const appSecret = process.env.ALIEXPRESS_APP_SECRET?.trim();
  if (!appKey || !appSecret) return null;
  return { appKey, appSecret };
}

/** Is AliExpress available to this deployment at all? */
export function aliexpressIsConfigured(): boolean {
  return aliexpressCredentials() !== null;
}

/** The method Genesis searches with. */
export const ALIEXPRESS_SEARCH_METHOD = "aliexpress.affiliate.product.query";

export type AliexpressCallResult<T> =
  | { ok: true; value: T }
  | { ok: false; failure: AliexpressFailure };

/**
 * One signed call.
 *
 * FOUR DISTINCT ENDINGS, kept distinct all the way up. A caller that collapsed
 * them would be unable to tell an owner the one thing they need: whether this
 * is something they can fix, something that will fix itself, or something
 * Genesis has to fix.
 */
async function call(
  method: string,
  args: Record<string, string | number | undefined>,
): Promise<AliexpressCallResult<unknown>> {
  const credentials = aliexpressCredentials();
  if (!credentials) {
    // Should not be reachable — callers check first — but a network call made
    // with an empty secret would produce a signature failure that read as bad
    // credentials rather than absent ones.
    return { ok: false, failure: { kind: "auth", detail: "AliExpress is not configured." } };
  }

  const params = buildSignedParams({
    method,
    appKey: credentials.appKey,
    appSecret: credentials.appSecret,
    args,
  });

  let response: Response;
  try {
    response = await fetch(ALIEXPRESS_GATEWAY, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
      // A sourcing search sits in front of an owner waiting for an answer.
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Network error";
    return { ok: false, failure: { kind: "provider", detail: `Couldn't reach AliExpress: ${detail}` } };
  }

  // 429 is the one status worth reading, because AliExpress does use it for
  // gateway-level throttling even though method-level limits come back as 200
  // with an error body.
  if (response.status === 429) {
    return { ok: false, failure: { kind: "rate_limit", detail: "AliExpress is rate-limiting Genesis." } };
  }

  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return {
      ok: false,
      failure: { kind: "provider", detail: `AliExpress returned something that wasn't JSON (HTTP ${response.status}).` },
    };
  }

  // THE BODY DECIDES, NOT THE STATUS. AliExpress answers 200 for failures.
  const failure = readFailure(body);
  if (failure) return { ok: false, failure };

  if (!response.ok) {
    return { ok: false, failure: { kind: "provider", detail: `AliExpress returned HTTP ${response.status}.` } };
  }

  return { ok: true, value: body };
}

/** Search the AliExpress catalog. */
export async function searchAliexpress(params: {
  keywords: string;
  limit: number;
  currency?: string;
}): Promise<AliexpressCallResult<AliexpressProduct[]>> {
  const result = await call(ALIEXPRESS_SEARCH_METHOD, {
    keywords: params.keywords,
    page_size: Math.min(Math.max(params.limit, 1), 50),
    page_no: 1,
    target_currency: params.currency ?? "USD",
    target_language: "EN",
    // Required by the affiliate methods. Genesis is not running an affiliate
    // programme, so this is the documented placeholder rather than a real id.
    tracking_id: process.env.ALIEXPRESS_TRACKING_ID?.trim() || "genesis",
  });

  if (!result.ok) return result;
  return { ok: true, value: readProducts(result.value) };
}
