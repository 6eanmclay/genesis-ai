import {
  parseRetryAfter,
  nextDelayMs,
  integrationFetch,
  isGoogleRateLimit,
  RateLimitedError,
  MAX_BACKOFF_MS,
} from "@/lib/integrations/rateLimit";

// Rate limiting, handled once. No database, no network, no real waiting:
//
//   npx tsx scripts/verify-rate-limit.ts
//
// Every delay is asserted rather than slept through — sleep is injected, so
// this suite proves the timing without taking any.

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

/** A fetch that replays a scripted list of responses and records the calls. */
function scriptedFetch(responses: Response[]) {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(String(url));
    const next = responses.shift();
    if (!next) throw new Error("scripted fetch ran out of responses");
    return next;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const limited = (headers: Record<string, string> = {}) => new Response("{}", { status: 429, headers });
const okResponse = () => new Response(JSON.stringify({ fine: true }), { status: 200 });

// ---------------------------------------------------------------------------
console.log("\n1. Retry-After, in both forms the spec allows");
{
  check("delta-seconds", parseRetryAfter("30", NOW), 30_000);
  check("zero is a real instruction, not absent", parseRetryAfter("0", NOW), 0);
  // RFC 9110 allows an HTTP-date, and providers do send it.
  check("an HTTP-date", parseRetryAfter("Thu, 20 Aug 2026 12:00:45 GMT", NOW), 45_000);
  // A date already past means now — never a negative wait, which would become
  // a negative setTimeout and fire instantly in a hot loop.
  check("a past date is 0, not negative", parseRetryAfter("Thu, 20 Aug 2026 11:59:00 GMT", NOW), 0);

  check("no header", parseRetryAfter(null, NOW), null);
  check("empty header", parseRetryAfter("   ", NOW), null);
  // Deliberately strict: "12abc" is not twelve seconds, it is a header we do
  // not understand. Guessing is worse than falling back to backoff.
  check("a header we do not understand is null, not a guess", parseRetryAfter("12abc", NOW), null);
}

// ---------------------------------------------------------------------------
console.log("\n2. The provider's instruction beats our guess");
{
  check("Retry-After wins outright", nextDelayMs(0, 30_000, () => 0.5), 30_000);
  check("even on a later attempt", nextDelayMs(5, 2_000, () => 0.5), 2_000);
  // Without an instruction: exponential, and capped so a serverless function
  // cannot be held open waiting.
  check("attempt 0 backs off", nextDelayMs(0, null, () => 0), 250);
  check("attempt 1 doubles", nextDelayMs(1, null, () => 0), 500);
  assert("and it is capped", nextDelayMs(20, null, () => 0) <= MAX_BACKOFF_MS + 1000);
}

// ---------------------------------------------------------------------------
console.log("\n3. Jitter is real, because Google asks for it by name");
{
  // Without a random component every client that hit the limit together
  // retries together and hits it again. Google documents this explicitly.
  const low = nextDelayMs(2, null, () => 0);
  const high = nextDelayMs(2, null, () => 0.999);
  assert("identical clients do not retry in lockstep", low !== high, `${low}ms vs ${high}ms`);
  assert("jitter never goes backwards", high > low);
}

// Sections 4-7 need await, and the script runner emits cjs — so they live in
// an async function rather than at top level.
async function asyncSections() {
  // ---------------------------------------------------------------------------
  console.log("\n4. A rate-limited call retries and then succeeds");
  {
    const { impl, calls } = scriptedFetch([limited({ "retry-after": "1" }), okResponse()]);
    const slept: number[] = [];
    const res = await integrationFetch(
      "https://api.example.com/x",
      {},
      { fetchImpl: impl, sleep: async (ms) => { slept.push(ms); }, now: () => NOW }
    );
    check("it eventually succeeded", res.status, 200);
    check("after exactly one retry", calls.length, 2);
    check("having waited the second the provider asked for", slept, [1000]);
    check("and the body is still readable by the caller", await res.json(), { fine: true });
  }

  // ---------------------------------------------------------------------------
  console.log("\n5. Exhausted retries raise the provider's own timing");
  {
    const { impl, calls } = scriptedFetch([
      limited({ "retry-after": "60" }),
      limited({ "retry-after": "60" }),
      limited({ "retry-after": "60" }),
    ]);
    const slept: number[] = [];
    let error: unknown = null;
    try {
      await integrationFetch(
        "https://api.example.com/x",
        {},
        { fetchImpl: impl, sleep: async (ms) => { slept.push(ms); }, now: () => NOW, label: "Mailchimp" }
      );
    } catch (e) {
      error = e;
    }
    assert("it throws RateLimitedError", error instanceof RateLimitedError);
    check("having used every attempt", calls.length, 3);
    // The last wait is not burned for nothing — after the final attempt it
    // throws immediately and hands the timing to the caller.
    check("and slept only BETWEEN attempts", slept.length, 2);
    const rateLimited = error as RateLimitedError;
    // This is the point of the whole module: the scheduler can now wait the
    // minute the provider asked for instead of guessing.
    check("the wait travels with the error", rateLimited.retryAfterMs, 60_000);
    check("as does the status", rateLimited.status, 429);
    assert("and a human can read it", rateLimited.message.includes("Mailchimp"), rateLimited.message);
  }

  // ---------------------------------------------------------------------------
  console.log("\n6. Only rate limiting is retried");
  {
    // A 400 means the request was wrong. Repeating it is just a slower 400.
    const { impl, calls } = scriptedFetch([new Response("bad", { status: 400 })]);
    const res = await integrationFetch("https://api.example.com/x", {}, { fetchImpl: impl, sleep: async () => {} });
    check("a 400 comes straight back", res.status, 400);
    check("with no retry", calls.length, 1);

    const { impl: impl2, calls: calls2 } = scriptedFetch([new Response("nope", { status: 401 })]);
    await integrationFetch("https://api.example.com/x", {}, { fetchImpl: impl2, sleep: async () => {} });
    check("nor is an expired token retried", calls2.length, 1);

    const { impl: impl3, calls: calls3 } = scriptedFetch([okResponse()]);
    await integrationFetch("https://api.example.com/x", {}, { fetchImpl: impl3, sleep: async () => {} });
    check("and a success costs exactly one call", calls3.length, 1);
  }

  // ---------------------------------------------------------------------------
  console.log("\n7. Google's 403 is a rate limit — and its 403 is also not");
  {
    // Google returns 403 for BOTH quota exhaustion and genuine permission
    // failures. Retrying a permission failure would be wrong, so the body decides.
    const quota = new Response(JSON.stringify({ error: { errors: [{ reason: "rateLimitExceeded" }] } }), { status: 403 });
    assert("a 403 rateLimitExceeded is a rate limit", isGoogleRateLimit(quota, await quota.clone().text()));

    const forbidden = new Response(JSON.stringify({ error: { errors: [{ reason: "insufficientPermissions" }] } }), {
      status: 403,
    });
    assert("a 403 for real missing permission is NOT", !isGoogleRateLimit(forbidden, await forbidden.clone().text()));

    const notFound = new Response("{}", { status: 404 });
    assert("and nothing else is", !isGoogleRateLimit(notFound, "{}"));

    // End to end: the 403 quota case retries, the 403 permission case does not.
    const { impl, calls } = scriptedFetch([
      new Response(JSON.stringify({ error: { errors: [{ reason: "userRateLimitExceeded" }] } }), { status: 403 }),
      okResponse(),
    ]);
    const res = await integrationFetch(
      "https://www.googleapis.com/x",
      {},
      { fetchImpl: impl, sleep: async () => {}, isRateLimited: isGoogleRateLimit }
    );
    check("Google's quota 403 is retried", calls.length, 2);
    check("and then succeeds", res.status, 200);

    const { impl: impl2, calls: calls2 } = scriptedFetch([
      new Response(JSON.stringify({ error: { errors: [{ reason: "insufficientPermissions" }] } }), { status: 403 }),
    ]);
    const res2 = await integrationFetch(
      "https://www.googleapis.com/x",
      {},
      { fetchImpl: impl2, sleep: async () => {}, isRateLimited: isGoogleRateLimit }
    );
    check("a genuine permission 403 is not retried", calls2.length, 1);
    check("it is returned for the connector to report", res2.status, 403);
  }
}

asyncSections()
  .then(() => {
    console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
