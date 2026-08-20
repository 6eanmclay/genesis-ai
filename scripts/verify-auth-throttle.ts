import {
  attemptBucket,
  PER_IDENTIFIER_LIMIT,
  PER_SOURCE_LIMIT,
  WINDOW_MS,
} from "@/lib/auth/attemptThrottle";
import { isAuthorizedCronRequest } from "@/lib/auth/cronAuth";

// Brute-force protection and the cron gate. No database, no network:
//
//   npx tsx scripts/verify-auth-throttle.ts
//
// Neither existed properly before 2026-08-20. Login, signup and password-reset
// requests could be hammered without limit; and the cron gate had a fail-open
// case that would have handed a public caller the cross-tenant scheduler.

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

const EMAIL = "owner@example.com";

// ---------------------------------------------------------------------------
console.log("\n1. What gets stored is never the address itself");
{
  // A throttle table full of plaintext emails typed by attackers — belonging to
  // real people who never signed up here — would be a liability created in the
  // name of security.
  const bucket = attemptBucket("signin:email", EMAIL);
  assert("the email does not appear in the bucket", !bucket.includes("owner"), bucket);
  assert("nor the domain", !bucket.includes("example.com"));
  assert("nor an @ at all", !bucket.includes("@"));
  check("it is a sha256 hex digest", /^[0-9a-f]{64}$/.test(bucket), true);

  const ipBucket = attemptBucket("signin:ip", "203.0.113.42");
  assert("an IP is hashed too", !ipBucket.includes("203.0.113"), ipBucket);
}

// ---------------------------------------------------------------------------
console.log("\n2. The same person always lands in the same bucket");
{
  check("stable across calls", attemptBucket("signin:email", EMAIL), attemptBucket("signin:email", EMAIL));
  // Otherwise "Owner@Example.com" is a free extra ten attempts, and so is
  // "OWNER@EXAMPLE.COM", and the limit means nothing.
  check("case does not create a new bucket", attemptBucket("signin:email", "Owner@Example.COM"), attemptBucket("signin:email", EMAIL));
  check("nor does surrounding whitespace", attemptBucket("signin:email", "  owner@example.com  "), attemptBucket("signin:email", EMAIL));
}

// ---------------------------------------------------------------------------
console.log("\n3. Different things never share a bucket");
{
  assert("a different email is a different bucket",
    attemptBucket("signin:email", "someone@else.com") !== attemptBucket("signin:email", EMAIL));
  // The kind is inside the hash, so sign-in failures cannot consume the
  // password-reset budget for the same address, or vice versa.
  assert("sign-in and reset are separate budgets",
    attemptBucket("signin:email", EMAIL) !== attemptBucket("reset:email", EMAIL));
  assert("email and IP are separate",
    attemptBucket("signin:email", "203.0.113.42") !== attemptBucket("signin:ip", "203.0.113.42"));
}

// ---------------------------------------------------------------------------
console.log("\n4. The two limits stop two different attacks");
{
  // Per-identifier catches a password list against one known address.
  // Per-source catches one common password sprayed across many addresses,
  // which never trips a per-identifier limit at all. Either alone leaves the
  // other attack completely untouched.
  assert("a per-identifier limit exists", PER_IDENTIFIER_LIMIT > 0);
  assert("a per-source limit exists", PER_SOURCE_LIMIT > 0);
  assert("the source limit is looser, because offices share an IP",
    PER_SOURCE_LIMIT > PER_IDENTIFIER_LIMIT, `${PER_SOURCE_LIMIT} vs ${PER_IDENTIFIER_LIMIT}`);
  // Tight enough to matter, loose enough that a person who mistypes a few
  // times is not locked out of their own business.
  assert("the identifier limit is not punitive", PER_IDENTIFIER_LIMIT >= 5 && PER_IDENTIFIER_LIMIT <= 20);
  assert("the window is minutes, not hours", WINDOW_MS >= 60_000 && WINDOW_MS <= 60 * 60_000, `${WINDOW_MS}ms`);
}

// ---------------------------------------------------------------------------
console.log("\n5. The cron gate fails CLOSED");
{
  // The bug: `authHeader !== \`Bearer ${process.env.CRON_SECRET}\`` compares
  // against the literal "Bearer undefined" when the secret is unset. Behind
  // that gate is runDueSyncs, the scheduler's cross-tenant execution bypass.
  assert("an unset secret authorizes nothing", !isAuthorizedCronRequest("Bearer undefined", undefined));
  assert("not even a correct-looking header", !isAuthorizedCronRequest("Bearer supersecret", undefined));
  assert("an empty secret authorizes nothing", !isAuthorizedCronRequest("Bearer ", ""));

  const secret = "a-real-cron-secret-value";
  assert("the right header is accepted", isAuthorizedCronRequest(`Bearer ${secret}`, secret));
  assert("a wrong secret is refused", isAuthorizedCronRequest("Bearer wrong-value-here-x", secret) === false);
  assert("a missing header is refused", !isAuthorizedCronRequest(null, secret));
  assert("an undefined header is refused", !isAuthorizedCronRequest(undefined, secret));
  assert("the bare secret without the scheme is refused", !isAuthorizedCronRequest(secret, secret));
  assert("a different scheme is refused", !isAuthorizedCronRequest(`Basic ${secret}`, secret));
  // A prefix must not pass: length is compared before the constant-time
  // comparison precisely so timingSafeEqual is never handed mismatched buffers.
  assert("a prefix of the secret is refused", !isAuthorizedCronRequest(`Bearer ${secret.slice(0, 5)}`, secret));
  assert("the secret with extra appended is refused", !isAuthorizedCronRequest(`Bearer ${secret}x`, secret));
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
