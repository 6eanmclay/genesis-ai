// GENESIS'S OWN USPS CREDENTIALS, AND THE TOKEN THEY MINT.
//
// ONE INTEGRATION FOR THE WHOLE PLATFORM. This is the point of the whole USPS
// direction: rates and address checking run on credentials Genesis holds, so a
// merchant gets both without opening an account, generating a key, or knowing
// that an API exists. Compare what they replace — every store needing its own
// EasyPost account, of which production currently has zero.
//
// INERT UNTIL CONFIGURED. With no USPS_CLIENT_ID set, every function here
// reports "not configured" and callers fall back to exactly what they did
// before. Deploying this cannot change a single existing checkout.
//
// WHAT THIS CANNOT DO YET, stated plainly: buy a label. That needs the Labels
// API, which USPS gates behind its own approval plus USPS Ship enrolment plus
// an Enterprise Payment Account — per merchant, not per platform. See
// lib/shipping/usps/README.md.

const PRODUCTION_BASE = "https://apis.usps.com";
const TEST_BASE = "https://apis-tem.usps.com";

/** Genesis's own USPS app. Never a merchant's. */
export interface UspsPlatformCredentials {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
  /**
   * The account Genesis prices against, when it has one.
   *
   * Optional because USPS's documentation does not state whether commercial
   * pricing requires it. Absent, requests omit the fields rather than sending
   * a placeholder.
   */
  account: { accountType: "EPS" | "PERMIT"; accountNumber: string } | null;
  /** Where parcels ship from, for rating. Falls back to the store's own. */
  originZip: string | null;
}

/**
 * Genesis's USPS configuration, or null.
 *
 * Read at call time rather than module load, so a deployment that gains the
 * variables starts working without a rebuild — and so tests can set them.
 */
export function uspsPlatformCredentials(): UspsPlatformCredentials | null {
  const clientId = process.env.USPS_CLIENT_ID?.trim();
  const clientSecret = process.env.USPS_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;

  const accountNumber = process.env.USPS_ACCOUNT_NUMBER?.trim();
  const rawType = process.env.USPS_ACCOUNT_TYPE?.trim().toUpperCase();

  return {
    clientId,
    clientSecret,
    // The test environment is a mirror of production for both credentials and
    // functionality, so pointing at it is the whole switch.
    baseUrl: process.env.USPS_USE_TEST_ENVIRONMENT === "1" ? TEST_BASE : PRODUCTION_BASE,
    account:
      accountNumber && (rawType === "EPS" || rawType === "PERMIT")
        ? { accountType: rawType, accountNumber }
        : null,
    originZip: process.env.USPS_ORIGIN_ZIP?.trim() || null,
  };
}

/** Is USPS available to this deployment at all? */
export function uspsIsConfigured(): boolean {
  return uspsPlatformCredentials() !== null;
}

interface CachedToken {
  accessToken: string;
  /** Epoch ms. */
  expiresAt: number;
}

// USPS TOKENS LAST EIGHT HOURS, so minting one per request would be both slow
// and rude. Cached in module scope, which is per serverless instance — the
// worst case is a few extra token calls after a cold start, never a stale
// token, because expiry is checked against the clock rather than assumed.
let cached: CachedToken | null = null;

/** Only for tests: forget the cached token. */
export function resetUspsTokenCache(): void {
  cached = null;
}

/** A minute of headroom, so a token cannot expire mid-request. */
const EXPIRY_SKEW_MS = 60_000;

export class UspsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UspsUnavailableError";
  }
}

/**
 * A valid OAuth token for Genesis's own USPS app.
 *
 * client_credentials, which is the grant USPS documents for server-to-server
 * use — there is no user in this flow at all.
 */
export async function uspsAccessToken(
  credentials: UspsPlatformCredentials,
  now: Date = new Date()
): Promise<string> {
  if (cached && cached.expiresAt - EXPIRY_SKEW_MS > now.getTime()) return cached.accessToken;

  const response = await fetch(`${credentials.baseUrl}/oauth2/v3/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
    }),
  });

  if (!response.ok) {
    throw new UspsUnavailableError(`USPS refused the credentials (${response.status})`);
  }

  const body = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) {
    throw new UspsUnavailableError("USPS returned no access token");
  }

  cached = {
    accessToken: body.access_token,
    // Trust USPS's own expiry when it gives one; eight hours is its documented
    // default and the fallback here, not a guess of our own.
    expiresAt: now.getTime() + (body.expires_in ?? 8 * 60 * 60) * 1000,
  };
  return cached.accessToken;
}

/**
 * One authenticated USPS call.
 *
 * Throws UspsUnavailableError on anything that is not a clean 2xx, so callers
 * can tell "USPS could not answer" from "USPS said no rates" — those are
 * different things to a customer standing at a checkout.
 */
export async function uspsFetch<T>(params: {
  credentials: UspsPlatformCredentials;
  path: string;
  method?: "GET" | "POST";
  body?: unknown;
  query?: Record<string, string>;
  now?: Date;
}): Promise<T> {
  const token = await uspsAccessToken(params.credentials, params.now);
  const url = new URL(`${params.credentials.baseUrl}${params.path}`);
  for (const [key, value] of Object.entries(params.query ?? {})) {
    if (value) url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    method: params.method ?? "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    ...(params.body !== undefined ? { body: JSON.stringify(params.body) } : {}),
  });

  if (response.status === 401) {
    // The cached token was rejected. Drop it so the next call mints a fresh
    // one rather than replaying a token USPS has already refused.
    cached = null;
    throw new UspsUnavailableError("USPS rejected the access token");
  }
  if (!response.ok) {
    throw new UspsUnavailableError(`USPS ${params.path} failed (${response.status})`);
  }

  return (await response.json()) as T;
}
