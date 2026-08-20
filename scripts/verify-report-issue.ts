import { reportIssue, type IssueSink } from "@/lib/observability/reportIssue";

// The operator-facing half of error handling. No database, no network:
//
//   npx tsx scripts/verify-report-issue.ts
//
// Sentry is wired and its DSN is set in production, but nineteen error paths
// across the webhooks, the checkout return, the scheduler and the execution
// engine were console.error and nothing else. Not one reached Sentry — and they
// are exactly the paths this audit added because they matter: a completed
// payment that produced no order, points that could not be credited, a capture
// that took money and could not be recorded.
//
// Two properties are worth proving rather than assuming. It must NEVER throw,
// because every call site is already inside a catch handling something that has
// gone wrong. And it must not leak the tokens that provider errors carry.

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

// Capture what would have gone to Sentry, and what went to the console.
const captured: { error: unknown; options: Record<string, unknown> }[] = [];
const consoleLines: string[] = [];

const realError = console.error;
console.error = (...args: unknown[]) => {
  consoleLines.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
};

const sink: IssueSink = (error, options) => {
  captured.push({ error, options: options as unknown as Record<string, unknown> });
};
const throwingSink: IssueSink = () => {
  throw new Error("Sentry is down");
};

function reset() {
  captured.length = 0;
  consoleLines.length = 0;
}

const TOKEN = "ya29.a0AfB_byC3xKfP9qRsTuVwXyZ01234567890abcdefGHIJKLMNOP";

// ---------------------------------------------------------------------------
reset();
reportIssue("a payment could not be recorded", new Error("boom"), {
  subsystem: "payments",
  stage: "stripe.unrecorded.persist",
  storeId: "store_1",
  extra: { sessionId: "cs_123" },
}, sink);
console.log("\n1. A real problem reaches the operator, tagged");
{
  check("it is sent to Sentry", captured.length, 1);
  const options = captured[0].options as { tags: Record<string, string>; extra: Record<string, unknown> };
  // Tagged, not buried: "which subsystem" and "which store" have to be filters
  // rather than a full-text search at 3am.
  check("tagged by subsystem", options.tags.subsystem, "payments");
  check("tagged by stage", options.tags.stage, "stripe.unrecorded.persist");
  check("tagged by store", options.tags.storeId, "store_1");
  assert("the original error object is preserved, not stringified", captured[0].error instanceof Error);
  check("and context travels with it", options.extra.sessionId, "cs_123");

  // The console line stays. It is what someone tailing logs during an incident
  // actually sees, and it costs nothing.
  check("it is also logged", consoleLines.length, 1);
  assert("with subsystem and stage in the prefix",
    consoleLines[0].includes("[payments/stripe.unrecorded.persist]"), consoleLines[0]);
}

// ---------------------------------------------------------------------------
console.log("\n2. Tokens do not travel to Sentry");
{
  reset();
  // Provider errors carry response bodies, which is why providerError.ts
  // exists. That redaction must apply here too, or the same token that was
  // kept out of the database goes to a third party instead.
  reportIssue(`token exchange failed: {"access_token":"${TOKEN}"}`, new Error("http 400"), {
    subsystem: "integrations",
    stage: "quickbooks.refresh",
    extra: { body: `refresh_token=${TOKEN}` },
  }, sink);
  const options = captured[0].options as { extra: Record<string, unknown> };
  assert("not in the message", !JSON.stringify(options.extra.message).includes(TOKEN), String(options.extra.message));
  assert("not in the extra context", !JSON.stringify(options.extra.body).includes(TOKEN), String(options.extra.body));
  assert("and not in the console line either", !consoleLines[0].includes(TOKEN));
  // And the useful part survives, or the redaction has eaten the signal.
  assert("the reason still reads", consoleLines[0].includes("token exchange failed"));
}

// ---------------------------------------------------------------------------
console.log("\n3. It never throws, whatever Sentry does");
{
  reset();
  let threw = false;
  try {
    reportIssue("something failed", new Error("x"), { subsystem: "payments", stage: "s" }, throwingSink);
  } catch {
    threw = true;
  }
  // Every call site is inside a catch, handling a payment or a sync that has
  // already gone wrong. A reporting failure there must not become the thing
  // that breaks it.
  assert("a Sentry outage does not propagate", !threw);
  assert("and the console line still happened", consoleLines.length === 1, consoleLines[0] ?? "(none)");
}

// ---------------------------------------------------------------------------
console.log("\n4. Awkward input does not break it");
{
  for (const [label, thrown] of [
    ["a string", "just a string"],
    ["null", null],
    ["undefined", undefined],
    ["a plain object", { code: "P2025" }],
  ] as const) {
    reset();
    let threw = false;
    try {
      reportIssue("odd failure", thrown, { subsystem: "scheduler", stage: "sync", storeId: null }, sink);
    } catch {
      threw = true;
    }
    assert(`${label} thrown value is handled`, !threw);
    assert(`${label} still reports`, captured.length === 1);
  }

  // A missing storeId is a real answer — a platform-level failure with no
  // tenant — and must not become the string "null" or "undefined" as a tag.
  reset();
  reportIssue("no tenant", new Error("x"), { subsystem: "billing", stage: "s", storeId: null }, sink);
  const tags = (captured[0].options as { tags: Record<string, string> }).tags;
  assert("no storeId tag is set when there is no store", !("storeId" in tags), JSON.stringify(tags));
}

console.error = realError;

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
