// Credential encryption at rest, attacked. No database, no network:
//
//   npx tsx scripts/verify-credential-encryption.ts
//
// This column holds merchants' Stripe Connect access tokens — which function as
// that account's own secret key — plus QuickBooks accounting tokens and typed
// API keys. It was plain JSON until Phase 3 M2.
//
// Construction alone is not evidence. AES-GCM is only authenticated if the auth
// tag is actually verified, and "we call setAuthTag" is not proof that a
// tampered ciphertext is rejected. So this tampers with every field and asserts
// each is refused.

// The module reads the key at call time, so this must be set before importing.
process.env.INTEGRATION_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

import { encryptCredentials, decryptCredentials } from "@/lib/integrations/credentials";

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

function refuses(label: string, fn: () => unknown): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  assert(label, threw);
}

const SECRET = { schemaVersion: 1, accessToken: "sk_live_REALMERCHANTTOKEN", refreshToken: "rft_REAL" };

// ---------------------------------------------------------------------------
console.log("\n1. A round trip, and no plaintext anywhere in what is stored");
{
  const stored = encryptCredentials(SECRET);
  const serialized = JSON.stringify(stored);

  // The whole point. If this ever fails, tokens are sitting in the database in
  // the clear.
  assert("the access token does not appear in the stored payload",
    !serialized.includes("sk_live_REALMERCHANTTOKEN"));
  assert("nor the refresh token", !serialized.includes("rft_REAL"));
  assert("nor any recognisable field name", !serialized.includes("accessToken"));

  check("and it decrypts back to exactly what went in", decryptCredentials(stored), SECRET);
}

// ---------------------------------------------------------------------------
console.log("\n2. The same secret encrypts differently every time");
{
  // A fixed IV would let anyone with two rows learn where they differ, and for
  // GCM specifically it is catastrophic — reusing an IV with the same key
  // breaks the authentication entirely.
  const a = JSON.stringify(encryptCredentials(SECRET));
  const b = JSON.stringify(encryptCredentials(SECRET));
  assert("two encryptions of identical data differ", a !== b);

  const ivA = (JSON.parse(a) as { iv: string }).iv;
  const ivB = (JSON.parse(b) as { iv: string }).iv;
  assert("because the IV is fresh each time", ivA !== ivB, `${ivA} vs ${ivB}`);
}

// ---------------------------------------------------------------------------
console.log("\n3. Tampering is detected, not silently decrypted");
{
  const stored = encryptCredentials(SECRET) as unknown as Record<string, string>;

  // Flip a byte in the ciphertext. Without a verified auth tag this would
  // decrypt to garbage — or, worse, to attacker-chosen plaintext.
  const bytes = Buffer.from(stored.ciphertext, "base64");
  bytes[0] ^= 0xff;
  refuses("a tampered ciphertext is refused",
    () => decryptCredentials({ ...stored, ciphertext: bytes.toString("base64") }));

  // Strip the tag's protection by replacing it.
  const fakeTag = Buffer.alloc(16, 1).toString("base64");
  refuses("a replaced auth tag is refused", () => decryptCredentials({ ...stored, authTag: fakeTag }));

  // Change the IV: same key, wrong nonce.
  const otherIv = Buffer.alloc(12, 9).toString("base64");
  refuses("a swapped IV is refused", () => decryptCredentials({ ...stored, iv: otherIv }));

  // Truncation.
  refuses("a truncated ciphertext is refused",
    () => decryptCredentials({ ...stored, ciphertext: stored.ciphertext.slice(0, 8) }));
}

// ---------------------------------------------------------------------------
console.log("\n4. A different key cannot read it");
{
  const stored = encryptCredentials(SECRET);
  const originalKey = process.env.INTEGRATION_ENCRYPTION_KEY;
  process.env.INTEGRATION_ENCRYPTION_KEY = Buffer.alloc(32, 8).toString("base64");
  refuses("ciphertext from another key is refused", () => decryptCredentials(stored));
  process.env.INTEGRATION_ENCRYPTION_KEY = originalKey;

  // And the original key still works afterwards, so the test itself is sound.
  check("the real key still reads it", decryptCredentials(stored), SECRET);
}

// ---------------------------------------------------------------------------
console.log("\n5. A missing or malformed key fails loudly");
{
  const originalKey = process.env.INTEGRATION_ENCRYPTION_KEY;

  delete process.env.INTEGRATION_ENCRYPTION_KEY;
  // Never silently store plaintext when the key is absent — that is the failure
  // mode that would put every merchant token in the clear at once.
  refuses("no key at all refuses to encrypt", () => encryptCredentials(SECRET));

  process.env.INTEGRATION_ENCRYPTION_KEY = Buffer.alloc(16, 1).toString("base64");
  refuses("a 16-byte key is refused, not stretched", () => encryptCredentials(SECRET));

  process.env.INTEGRATION_ENCRYPTION_KEY = "not-base64-at-all!!";
  refuses("a malformed key is refused", () => encryptCredentials(SECRET));

  process.env.INTEGRATION_ENCRYPTION_KEY = originalKey;
}

// ---------------------------------------------------------------------------
console.log("\n6. Anything that is not our envelope is refused");
{
  // Rows predating encryption were plain JSON. Reading one must fail loudly
  // rather than returning a half-understood object.
  refuses("a legacy plaintext row is refused", () => decryptCredentials({ accessToken: "sk_live_old" }));
  refuses("null is refused", () => decryptCredentials(null));
  refuses("a string is refused", () => decryptCredentials("nope"));
  refuses("an empty object is refused", () => decryptCredentials({}));
  // A future format must not be read by today's code as if it were this one.
  refuses("an unknown schema version is refused",
    () => decryptCredentials({ schemaVersion: "encrypted:2", iv: "x", authTag: "y", ciphertext: "z" }));
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
