import { authFor } from "@/lib/integrations/mailchimp";

// Mailchimp's OAuth conversion, and the connections it must not break.
// No database, no network:
//
//   npx tsx scripts/verify-mailchimp-auth.ts
//
// Mailchimp was asking business owners to paste an API key even though it
// supports OAuth2 — handing over the whole account permanently, in a form the
// owner cannot see, narrow, or withdraw from Genesis's side. It uses OAuth now.
//
// The risk in a conversion like this is not the new path; it is the stores
// already connected the old way. Section 2 is those stores.

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

const OAUTH = { schemaVersion: 2 as const, accessToken: "tok_abc123", dc: "us6" };
// Deliberately NOT shaped like a real Mailchimp key (32 hex + "-us<n>").
// The first version of this fixture was, and GitHub's secret scanner blocked
// the push — correctly: a scanner cannot tell a convincing fake from the real
// thing, and neither can a person skimming a diff. What this test needs is the
// "-<datacenter>" suffix, and nothing else.
const LEGACY = { schemaVersion: 1 as const, apiKey: "not-a-real-key-us19" };

// ---------------------------------------------------------------------------
console.log("\n1. An OAuth connection calls Mailchimp the way Mailchimp documents");
{
  const { base, headers } = authFor(OAUTH);
  // Mailchimp's own header is "OAuth", not "Bearer" — a real difference from
  // every other connector here, and the kind of detail that fails as a 401
  // with no explanation if assumed.
  check("the scheme is OAuth", headers.Authorization, "OAuth tok_abc123");
  assert("not Bearer", !headers.Authorization.startsWith("Bearer"));
  // The token does not say which datacenter to call; the metadata endpoint
  // does, once, at connect. Guessing a prefix produces 404s that look like a
  // broken account.
  check("the base comes from the stored server prefix", base, "https://us6.api.mailchimp.com/3.0");
}

// ---------------------------------------------------------------------------
console.log("\n2. A store connected BEFORE the conversion still works");
{
  const { base, headers } = authFor(LEGACY);
  assert("its key is still used as a key", headers.Authorization.startsWith("Basic "));
  // Mailchimp keys carry their own datacenter suffix, so the base is derived
  // from the key rather than from anything we stored separately.
  check("and its datacenter still comes off the key", base, "https://us19.api.mailchimp.com/3.0");

  const decoded = Buffer.from(headers.Authorization.slice("Basic ".length), "base64").toString();
  check("Basic auth is username:key, as Mailchimp expects", decoded, `anystring:${LEGACY.apiKey}`);
  // The whole point: nobody is forced to reconnect mid-campaign because
  // Genesis changed how it authenticates.
  assert("no reconnect is forced", base.length > 0 && headers.Authorization.length > 0);
}

// ---------------------------------------------------------------------------
console.log("\n3. The two shapes are never confused for one another");
{
  assert("an OAuth connection never sends Basic", !authFor(OAUTH).headers.Authorization.startsWith("Basic"));
  assert("a legacy connection never sends OAuth", !authFor(LEGACY).headers.Authorization.startsWith("OAuth"));
  assert("and they do not share a base", authFor(OAUTH).base !== authFor(LEGACY).base);
}

// ---------------------------------------------------------------------------
console.log("\n4. A malformed legacy key is refused, not half-used");
{
  // A key with no "-<dc>" suffix has no datacenter, so there is no correct URL
  // to call. Throwing beats calling "https://undefined.api.mailchimp.com".
  let threw = false;
  try {
    authFor({ schemaVersion: 1, apiKey: "abcdef0123456789" });
  } catch {
    threw = true;
  }
  assert("a key with no datacenter suffix throws", threw);
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
