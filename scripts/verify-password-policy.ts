import { checkPassword, MIN_LENGTH, MAX_BYTES } from "@/lib/auth/passwordPolicy";
import { isTokenIssuedBeforePasswordChange } from "@/lib/auth/passwordReset";

// What counts as an acceptable password. No database, no network:
//
//   npx tsx scripts/verify-password-policy.ts
//
// There was no requirement at all until 2026-08-20. Signup checked only that a
// password was present and the reset flow checked nothing, so "a" was a valid
// password on a platform that holds merchants' connected Stripe accounts.
//
// The rules follow NIST SP 800-63B: length is what matters, and composition
// rules ("one uppercase, one symbol") are counterproductive. Section 3 asserts
// that we did NOT add them, which is as much a decision as adding them.

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

// ---------------------------------------------------------------------------
console.log("\n1. The passwords that used to be accepted");
{
  // Every one of these was valid before this file existed.
  for (const trivial of ["a", "1", "abc", "pass", "1234567"]) {
    assert(`"${trivial}" is refused`, !checkPassword(trivial).ok);
  }
  check("the boundary is exactly the documented minimum", checkPassword("a".repeat(MIN_LENGTH - 1)).ok, false);
  check("and one more character passes", checkPassword("a".repeat(MIN_LENGTH)).ok, true);
}

// ---------------------------------------------------------------------------
console.log("\n2. bcrypt's 72-byte truncation is respected, not ignored");
{
  // bcrypt hashes only the first 72 BYTES and silently discards the rest, so
  // beyond that two different passwords become the same stored password.
  // Accepting one would mean storing something other than what was typed.
  assert("a password at the limit is fine", checkPassword("x".repeat(MAX_BYTES)).ok);
  assert("one byte over is refused", !checkPassword("x".repeat(MAX_BYTES + 1)).ok);

  // Bytes, not characters. An emoji is four bytes, so 20 of them is 80 bytes
  // and would be silently truncated despite being only 20 "characters".
  const emoji = "\u{1F511}".repeat(20);
  assert("the limit counts bytes, not characters", !checkPassword(emoji).ok, `${emoji.length} chars`);
  // And a passphrase of accented characters that fits is still allowed.
  assert("a normal accented passphrase is fine", checkPassword("café-terrasse-matin").ok);
}

// ---------------------------------------------------------------------------
console.log("\n3. No composition rules — deliberately");
{
  // NIST is explicit that requiring "one uppercase, one digit, one symbol"
  // makes passwords worse: it pushes people to Password1! and away from long
  // passphrases. These assertions exist so nobody "improves" that later.
  assert("a long all-lowercase passphrase is accepted", checkPassword("correct horse battery staple").ok);
  assert("no digit is required", checkPassword("purple monkey dishwasher").ok);
  assert("no symbol is required", checkPassword("thequickbrownfox").ok);
  assert("no uppercase is required", checkPassword("anchovies and lemon").ok);
  // Spaces are a legitimate part of a passphrase and must not be stripped or
  // rejected.
  assert("spaces are allowed", checkPassword("two words here").ok);
}

// ---------------------------------------------------------------------------
console.log("\n4. The obvious ones are refused whatever the casing");
{
  assert("password", !checkPassword("password").ok);
  assert("PASSWORD", !checkPassword("PASSWORD").ok);
  assert("PaSsWoRd", !checkPassword("PaSsWoRd").ok);
  assert("password123", !checkPassword("password123").ok);
  assert("12345678", !checkPassword("12345678").ok);
  // Not an over-broad substring match: a real passphrase that merely contains
  // a common word is fine.
  assert("but 'my password is long' is fine", checkPassword("my password is long").ok);
}

// ---------------------------------------------------------------------------
console.log("\n5. A refusal tells the person what to do");
{
  // These strings are read by someone mid-signup who is now stuck.
  const tooShort = checkPassword("abc");
  assert("the length message is actionable", !tooShort.ok && tooShort.message.includes("at least"));
  assert("and suggests a passphrase", !tooShort.ok && tooShort.message.toLowerCase().includes("few words"));

  const common = checkPassword("password");
  assert("the common-password message explains why", !common.ok && common.message.includes("commonly used"));

  const tooLong = checkPassword("x".repeat(MAX_BYTES + 5));
  assert("the length-limit message gives the limit", !tooLong.ok && tooLong.message.includes(String(MAX_BYTES)));

  // All three must differ — a single generic "invalid password" would leave
  // someone guessing which rule they hit.
  const messages = new Set([tooShort, common, tooLong].map((r) => (r.ok ? "" : r.message)));
  check("each rule has its own message", messages.size, 3);
}

// ---------------------------------------------------------------------------
console.log("\n6. A password reset actually evicts whoever prompted it");
{
  // Sessions are JWTs, so there is no session row to delete. A token already
  // in an attacker's hands stayed valid after a reset until it expired on its
  // own — which made "someone got into my account, I'll change my password"
  // fail at the one thing it exists to do.
  const changedAt = new Date("2026-08-20T12:00:00.000Z");
  const asIat = (d: string) => Math.floor(new Date(d).getTime() / 1000);

  assert(
    "a token minted BEFORE the reset is refused",
    isTokenIssuedBeforePasswordChange(asIat("2026-08-20T11:59:00.000Z"), changedAt)
  );
  assert(
    "a token minted AFTER it is kept",
    !isTokenIssuedBeforePasswordChange(asIat("2026-08-20T12:01:00.000Z"), changedAt)
  );

  // THE trap. `iat` is seconds; Date is milliseconds. Comparing them directly
  // puts 1.7e9 against 1.7e12 — always "older" — and signs out every user on
  // the platform on their next request. This assertion is the whole reason
  // this function was extracted rather than left inline in the jwt callback.
  const recent = asIat("2026-08-21T00:00:00.000Z");
  assert(
    "seconds are not compared against milliseconds",
    !isTokenIssuedBeforePasswordChange(recent, changedAt),
    `iat=${recent} vs ${changedAt.getTime()}`
  );

  // An account that has never reset has nothing to refuse — the overwhelming
  // majority of users, every one of whom would be logged out by a null bug.
  assert("no stamp means no eviction", !isTokenIssuedBeforePasswordChange(asIat("2020-01-01T00:00:00.000Z"), null));
  assert("nor does undefined", !isTokenIssuedBeforePasswordChange(asIat("2020-01-01T00:00:00.000Z"), undefined));
  // A token predating this field existing has no iat we can trust; refusing it
  // would be an outage rather than a security measure.
  assert("a token with no iat is kept", !isTokenIssuedBeforePasswordChange(undefined, changedAt));
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
