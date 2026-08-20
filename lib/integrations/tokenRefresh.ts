// Merging a refresh response into stored credentials (2026-08-20).
//
// Extracted because getting this wrong killed a real production connection.
// QuickBooks was refreshed, Intuit returned a NEW refresh token as it always
// does, the connector kept only the access token, and the next refresh
// presented a token Intuit had already retired. Eleven consecutive 400s, and
// the one connector feeding J4 real business data went dark for eighteen days.
//
// The rule is one line long and worth a test of its own: keep whatever the
// provider just sent, and fall back to what we already had only when it sent
// nothing.

export interface RefreshableCredentials {
  accessToken: string;
  // Optional because it genuinely is for some providers: a Google connection
  // authorized without offline access has none, and pretending otherwise would
  // only push the null somewhere less visible.
  refreshToken?: string;
  expiresAt: number;
}

export interface TokenRefreshResponse {
  access_token: string;
  expires_in: number;
  /** Providers that rotate (Intuit) send this every time. Google usually omits it. */
  refresh_token?: string;
}

/**
 * Fold a provider's refresh response into the credentials to store — pure.
 *
 * `now` is injected so expiry is a provable number rather than something only
 * observable against the wall clock.
 */
export function mergeRefreshedTokens<T extends RefreshableCredentials>(
  current: T,
  response: TokenRefreshResponse,
  now: Date = new Date()
): T {
  return {
    ...current,
    accessToken: response.access_token,
    // A provider that rotates invalidates the old token the moment it issues a
    // new one. Dropping the new value is what turns a working connection into a
    // permanently broken one.
    refreshToken: response.refresh_token ?? current.refreshToken,
    expiresAt: now.getTime() + response.expires_in * 1000,
  };
}
