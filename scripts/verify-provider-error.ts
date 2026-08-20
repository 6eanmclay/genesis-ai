import { describeProviderError, redactSecrets } from "@/lib/integrations/providerError";

// What a failed provider call is allowed to say. No database, no network:
//
//   npx tsx scripts/verify-provider-error.ts
//
// These messages are not ephemeral. They are caught by the execution engine,
// written to ExecutionLog.message in the database, and rendered on the owner's
// Connections card — so a secret that reaches one persists until someone
// deletes the row. Section 1 is the shape that used to be thrown verbatim.

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

const SECRET = "ya29.a0AfB_byC3xKfP9qRsTuVwXyZ01234567890abcdefGHIJKLMNOP";

// ---------------------------------------------------------------------------
console.log("\n1. A token never survives, however the provider labels it");
{
  // The exact shape that used to be interpolated straight into the error:
  // a provider echoing the request back inside its own failure.
  const body = JSON.stringify({
    error: "invalid_request",
    error_description: `The token ${SECRET} was rejected`,
  });
  const message = describeProviderError({ provider: "QuickBooks", status: 400, bodyText: body, stage: "token exchange" });
  assert("the secret is gone", !message.includes(SECRET), message);
  assert("but the reason survives", message.includes("invalid_request"));
  assert("and so does the status", message.includes("400"));

  // Every key a provider might use for the same thing.
  for (const key of ["access_token", "refresh_token", "client_secret", "id_token"]) {
    const echoed = JSON.stringify({ error: "bad", error_description: `{"${key}":"${SECRET}"}` });
    const out = describeProviderError({ provider: "X", status: 401, bodyText: echoed });
    assert(`${key} is redacted`, !out.includes(SECRET), out.slice(0, 80));
  }

  // Form-encoded, which is how OAuth token requests are actually sent.
  assert(
    "a form-encoded secret is redacted too",
    !redactSecrets(`grant_type=refresh_token&client_secret=${SECRET}&x=1`).includes(SECRET)
  );
  // And an unlabelled one, on shape alone.
  assert("as is a bare token-shaped run", !redactSecrets(`something went wrong near ${SECRET}`).includes(SECRET));
}

// ---------------------------------------------------------------------------
console.log("\n2. Ordinary prose is not mangled by the redaction");
{
  // The redaction is worthless if it eats the message it was protecting.
  const plain = "The refresh token is invalid or expired. Please reconnect.";
  check("normal sentences pass through untouched", redactSecrets(plain), plain);
  assert("even mentioning a token by name", redactSecrets("refresh token expired") === "refresh token expired");
  // 40 characters is deliberately conservative: real error prose has spaces.
  const longWords = "authorization was denied because consent lapsed";
  check("and a long sentence is not a token", redactSecrets(longWords), longWords);
}

// ---------------------------------------------------------------------------
console.log("\n3. The provider's own reason is what a human gets");
{
  const oauth = JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." });
  check(
    "OAuth's standard error shape reads as a sentence",
    describeProviderError({ provider: "Google", status: 400, bodyText: oauth, stage: "token refresh" }),
    "Google token refresh failed (400): invalid_grant: Token has been expired or revoked."
  );

  // Meta and others nest the message one level down.
  const nested = JSON.stringify({ error: { message: "Session has expired", code: 190 } });
  const out = describeProviderError({ provider: "Facebook", status: 400, bodyText: nested });
  assert("a nested error message is found", out.includes("Session has expired"), out);
}

// ---------------------------------------------------------------------------
console.log("\n4. A body with nothing useful in it says nothing useful");
{
  // An HTML error page or a proxy's plain text has no reliable "reason" in it,
  // so none is quoted — the status stands on its own rather than dumping markup
  // onto a business owner's screen.
  const html = "<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>";
  check(
    "an HTML error page is not quoted",
    describeProviderError({ provider: "Printful", status: 502, bodyText: html }),
    "Printful failed (502)."
  );
  check(
    "nor is an empty body",
    describeProviderError({ provider: "TikTok", status: 500, bodyText: "", stage: "sync" }),
    "TikTok sync failed (500)."
  );
  check(
    "nor a missing one",
    describeProviderError({ provider: "TikTok", status: 500 }),
    "TikTok failed (500)."
  );
  check(
    "and valid JSON with no message field still gives the status",
    describeProviderError({ provider: "X", status: 418, bodyText: JSON.stringify({ log_id: "abc" }) }),
    "X failed (418)."
  );
}

// ---------------------------------------------------------------------------
console.log("\n5. Length is bounded");
{
  // A provider returning a wall of text must not write a wall of text into the
  // database, or onto the card.
  const wall = JSON.stringify({ error_description: "verbose ".repeat(200) });
  const out = describeProviderError({ provider: "X", status: 400, bodyText: wall });
  assert("the message is clipped", out.length < 300, `${out.length} chars`);
  assert("and says it was clipped", out.endsWith("…"), out.slice(-20));
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
