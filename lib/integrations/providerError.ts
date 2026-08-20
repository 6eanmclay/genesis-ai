// What a failed provider call is allowed to say (2026-08-20).
//
// Found while auditing this document's own claim that Genesis "never records
// request bodies or headers, which is where tokens live". True of requests, and
// not true of RESPONSES: nine call sites did
//
//     const body = await res.text();
//     throw new Error(`... failed (${res.status}): ${body}`);
//
// and that message is not ephemeral. It is caught by the execution engine,
// written to ExecutionLog.message in the database, and rendered on the owner's
// Connections card. Three problems, in increasing order of seriousness:
//
//   1. A business owner is shown a raw JSON blob from an API they have never
//      heard of, which tells them nothing they can act on.
//   2. Token endpoints are exactly where credentials live. A failure body is
//      usually just {"error": "invalid_grant"}, but "usually" is not a security
//      property — providers have echoed submitted parameters back in errors.
//   3. It is durable. A secret in a log line scrolls away; a secret in
//      ExecutionLog persists until someone deletes the row.
//
// So the status code and the provider's own error NAME survive, because those
// are what diagnose the problem, and everything else is redacted or dropped.

/** Keys whose values are never repeated back, whatever the provider sends. */
const SECRET_KEYS = [
  "access_token",
  "refresh_token",
  "client_secret",
  "client_id",
  "code",
  "id_token",
  "apiKey",
  "api_key",
  "authorization",
];

/** The fields providers actually put a human-readable reason in. */
// Order matters: the error NAME leads, then its description — "invalid_grant:
// Token has been expired or revoked." reads as a sentence; the reverse does not.
const MESSAGE_KEYS = ["error", "error_description", "error_message", "message", "detail"];

const MAX_LENGTH = 200;

/**
 * Redact secret-looking values out of arbitrary text — exported for the case
 * where a body cannot be parsed and something still has to be said about it.
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const key of SECRET_KEYS) {
    // JSON form: "access_token":"..." / "access_token": "..."
    out = out.replace(new RegExp(`("${key}"\\s*:\\s*)"[^"]*"`, "gi"), `$1"[redacted]"`);
    // Form-encoded / query form: access_token=...
    out = out.replace(new RegExp(`(${key}=)[^&\\s"']+`, "gi"), `$1[redacted]`);
  }
  // A long unbroken token-shaped run, whatever it was labelled. Deliberately
  // conservative at 40 characters: real error prose has spaces in it.
  out = out.replace(/\b[A-Za-z0-9._~+/-]{40,}={0,2}\b/g, "[redacted]");
  return out;
}

/**
 * One sentence a human can act on, from a failed provider response — pure.
 *
 * `bodyText` is the raw response body. Nothing from it reaches the output
 * unredacted, and nothing at all reaches it beyond the provider's own error
 * name and description.
 */
export function describeProviderError(params: {
  provider: string;
  status: number;
  bodyText?: string;
  /** What was being attempted, e.g. "token exchange". Ours, not the provider's. */
  stage?: string;
}): string {
  const { provider, status, bodyText = "", stage } = params;
  const what = stage ? `${provider} ${stage}` : provider;

  let reason = "";
  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of MESSAGE_KEYS) {
      const value = parsed[key];
      // Providers nest: {"error": {"message": "..."}}. Take the string form.
      if (typeof value === "string" && value.trim() !== "") {
        parts.push(value.trim());
      } else if (value && typeof value === "object") {
        const nested = value as Record<string, unknown>;
        for (const inner of MESSAGE_KEYS) {
          if (typeof nested[inner] === "string" && (nested[inner] as string).trim() !== "") {
            parts.push((nested[inner] as string).trim());
            break;
          }
        }
      }
      if (parts.length >= 2) break;
    }
    reason = parts.join(": ");
  } catch {
    // Not JSON — an HTML error page or a proxy's plain text. Nothing in there
    // is a reliable "reason", so it is not quoted at all; the status stands.
    reason = "";
  }

  if (reason === "") return `${what} failed (${status}).`;

  const safe = redactSecrets(reason);
  const clipped = safe.length > MAX_LENGTH ? `${safe.slice(0, MAX_LENGTH - 1)}…` : safe;
  return `${what} failed (${status}): ${clipped}`;
}
