import { mergeRefreshedTokens } from "@/lib/integrations/tokenRefresh";

// The bug that took QuickBooks down for eighteen days, and the rule that fixes
// it. No database, no network:
//
//   npx tsx scripts/verify-token-refresh.ts
//
// Intuit rotates the refresh token on every refresh. The connector kept only
// the access token and threw the new refresh token away, so the next refresh
// presented one Intuit had already retired — eleven consecutive 400s, and the
// only connector feeding J4 real business data went dark.

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}

function assert(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

const NOW = new Date("2026-08-20T12:00:00.000Z");
const STORED = {
  schemaVersion: 1 as const,
  accessToken: "access_old",
  refreshToken: "refresh_old",
  realmId: "realm_1",
  expiresAt: NOW.getTime() - 1000,
};

// ---------------------------------------------------------------------------
console.log("\n1. A rotated refresh token is kept — the actual bug");
{
  // Exactly what Intuit returns: a new access token AND a new refresh token.
  const merged = mergeRefreshedTokens(STORED, {
    access_token: "access_new",
    refresh_token: "refresh_new",
    expires_in: 3600,
  }, NOW);

  check("the new access token is stored", merged.accessToken, "access_new");
  check("the NEW refresh token is stored", merged.refreshToken, "refresh_new");
  // This is the assertion that would have caught the outage.
  assert("the retired token is not kept", merged.refreshToken !== "refresh_old");
  check("expiry is computed from the response", merged.expiresAt, NOW.getTime() + 3600 * 1000);
}

// ---------------------------------------------------------------------------
console.log("\n2. A provider that sends no refresh token keeps the existing one");
{
  // Google's usual response: access token only.
  const merged = mergeRefreshedTokens(STORED, { access_token: "access_new", expires_in: 3599 }, NOW);
  check("access token updated", merged.accessToken, "access_new");
  check("existing refresh token preserved", merged.refreshToken, "refresh_old");
  assert("and it is not blanked", merged.refreshToken !== undefined);
}

// ---------------------------------------------------------------------------
console.log("\n3. Nothing else about the credentials is disturbed");
{
  const merged = mergeRefreshedTokens(STORED, { access_token: "a", expires_in: 60 }, NOW);
  check("schema version survives", merged.schemaVersion, 1);
  check("provider-specific fields survive", merged.realmId, "realm_1");
  check(
    "and the shape is unchanged",
    Object.keys(merged).sort(),
    ["accessToken", "expiresAt", "realmId", "refreshToken", "schemaVersion"]
  );
}

// ---------------------------------------------------------------------------
console.log("\n4. Repeated refreshes chain, rather than reverting");
{
  // The real failure was that refresh #2 used the token refresh #1 retired.
  // Chaining proves each refresh hands the next one a live token.
  let credentials = STORED;
  for (const round of [1, 2, 3]) {
    credentials = mergeRefreshedTokens(
      credentials,
      { access_token: `access_${round}`, refresh_token: `refresh_${round}`, expires_in: 3600 },
      NOW
    );
  }
  check("the newest refresh token wins after three rounds", credentials.refreshToken, "refresh_3");
  check("and the newest access token too", credentials.accessToken, "access_3");
  assert("the original retired token is long gone", credentials.refreshToken !== "refresh_old");
}

// ---------------------------------------------------------------------------
console.log("\n5. Expiry is real, and in the future");
{
  const merged = mergeRefreshedTokens(STORED, { access_token: "a", expires_in: 3600 }, NOW);
  assert("expiry moved forward", merged.expiresAt > NOW.getTime(), `${merged.expiresAt - NOW.getTime()}ms`);
  // A zero-lifetime response is honestly stored as already expired rather than
  // padded into looking valid.
  check("a zero lifetime is not padded", mergeRefreshedTokens(STORED, { access_token: "a", expires_in: 0 }, NOW).expiresAt, NOW.getTime());
}

// ---------------------------------------------------------------------------
console.log("\n6. The same rotation, on the two connectors that also do it");
{
  // The same bug was still sitting in TikTok on 2026-08-20, unfired only
  // because nobody had connected TikTok in production yet. TikTok's own docs:
  // "The returned refresh_token may be different than the one passed in the
  // payload. You must use the newly-returned token if the value is different
  // than the previous one." The connector read only access_token.
  const tiktok = {
    schemaVersion: 1 as const,
    accessToken: "act.old",
    refreshToken: "rft.old",
    openId: "open_1",
    expiresAt: NOW.getTime() - 1000,
  };
  const merged = mergeRefreshedTokens(
    tiktok,
    { access_token: "act.new", refresh_token: "rft.new", expires_in: 86400 },
    NOW
  );
  check("TikTok's rotated refresh token is kept", merged.refreshToken, "rft.new");
  check("and its 24h access token", merged.accessToken, "act.new");
  check("open_id is not disturbed", merged.openId, "open_1");
  assert("the retired token is gone here too", merged.refreshToken !== "rft.old");

  // Printful returns a refresh_token on every renewal and is treated the same.
  const printful = {
    schemaVersion: 1 as const,
    accessToken: "pf_old",
    refreshToken: "pf_refresh_old",
    printfulStoreId: 42,
    expiresAt: NOW.getTime() - 1000,
  };
  const pf = mergeRefreshedTokens(
    printful,
    { access_token: "pf_new", refresh_token: "pf_refresh_new", expires_in: 3600 },
    NOW
  );
  check("Printful's rotated token is kept", pf.refreshToken, "pf_refresh_new");
  check("and its store id survives", pf.printfulStoreId, 42);
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
