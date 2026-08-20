import { nextSyncAttempt } from "@/lib/intelligence/scheduler";

// When a connector is tried again, and what that says about its health.
// No database, no network:
//
//   npx tsx scripts/verify-sync-backoff.ts
//
// The distinction this file exists to protect: a rate limit is NOT a failure.
// The connector answered — it just asked us to come back later. Counting that
// as a failure walks a popular connection up the exponential curve toward the
// 24h cap, and the owner sees something that "stopped syncing" when nothing is
// wrong with it.

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

const NOW = new Date("2026-08-20T12:00:00.000Z").getTime();
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const waitMs = (r: { nextSyncDueAt: Date }) => r.nextSyncDueAt.getTime() - NOW;

// ---------------------------------------------------------------------------
console.log("\n1. A successful sync resets everything");
{
  const r = nextSyncAttempt({ outcome: "success", failureCount: 4, now: NOW });
  check("the failure streak is cleared", r.syncFailureCount, 0);
  check("and the normal 6h cadence resumes", waitMs(r), 6 * HOUR);
}

// ---------------------------------------------------------------------------
console.log("\n2. A real failure backs off exponentially, and is capped");
{
  const first = nextSyncAttempt({ outcome: "failure", failureCount: 0, now: NOW });
  check("one failure counts", first.syncFailureCount, 1);
  check("and doubles the interval", waitMs(first), 12 * HOUR);

  const second = nextSyncAttempt({ outcome: "failure", failureCount: 1, now: NOW });
  check("two failures counts", second.syncFailureCount, 2);
  check("and quadruples it", waitMs(second), 24 * HOUR);

  // Without a cap, a connection broken for a week would schedule itself years out.
  const many = nextSyncAttempt({ outcome: "failure", failureCount: 20, now: NOW });
  check("but never beyond a day", waitMs(many), 24 * HOUR);
  assert("while still counting the failure", many.syncFailureCount === 21);
}

// ---------------------------------------------------------------------------
console.log("\n3. A rate limit waits exactly as long as the provider asked");
{
  const r = nextSyncAttempt({ outcome: "rate_limited", retryAfterMs: 90 * 1000, failureCount: 0, now: NOW });
  check("ninety seconds means ninety seconds", waitMs(r), 90 * 1000);
  // Not six hours, and not the failure curve — both would be a guess when the
  // provider gave an actual answer.
  assert("not the 6h cadence", waitMs(r) !== 6 * HOUR);
  assert("not the failure backoff", waitMs(r) !== 12 * HOUR);
}

// ---------------------------------------------------------------------------
console.log("\n4. A rate limit is not a failure");
{
  // The whole point. A healthy, popular connection must not be walked up the
  // exponential curve for the crime of being used.
  const r = nextSyncAttempt({ outcome: "rate_limited", retryAfterMs: 60_000, failureCount: 0, now: NOW });
  check("a healthy connection stays at zero failures", r.syncFailureCount, 0);

  // Nor does it clear a real streak: being throttled proves nothing either way
  // about whether the credentials still work.
  const streak = nextSyncAttempt({ outcome: "rate_limited", retryAfterMs: 60_000, failureCount: 3, now: NOW });
  check("and an existing streak is preserved, not reset", streak.syncFailureCount, 3);
  assert("it is left exactly as it was", streak.syncFailureCount === 3);
}

// ---------------------------------------------------------------------------
console.log("\n5. A rate limit with no stated wait still behaves sensibly");
{
  // Mailchimp and TikTok both return 429 without documenting Retry-After.
  for (const missing of [null, undefined, 0]) {
    const r = nextSyncAttempt({ outcome: "rate_limited", retryAfterMs: missing, failureCount: 0, now: NOW });
    // Five minutes, not six hours: these limits are per-minute, so losing a
    // whole cycle over one throttled call would be a self-inflicted outage.
    check(`retryAfterMs=${String(missing)} falls back to 5 minutes`, waitMs(r), 5 * MINUTE);
  }
  assert(
    "and the fallback is far shorter than a failure backoff",
    waitMs(nextSyncAttempt({ outcome: "rate_limited", retryAfterMs: null, failureCount: 0, now: NOW })) <
      waitMs(nextSyncAttempt({ outcome: "failure", failureCount: 0, now: NOW }))
  );
}

// ---------------------------------------------------------------------------
console.log("\n6. Even a provider's own instruction is bounded");
{
  // A provider asking us to wait a week — or a malformed header parsed as an
  // enormous number — must not park a connection past the point of noticing.
  const absurd = nextSyncAttempt({
    outcome: "rate_limited",
    retryAfterMs: 30 * 24 * HOUR,
    failureCount: 0,
    now: NOW,
  });
  check("capped at 24h like everything else", waitMs(absurd), 24 * HOUR);
}

// ---------------------------------------------------------------------------
console.log("\n7. Every outcome moves the clock forward");
{
  // A due-time in the past or present would make the scheduler pick the same
  // connector again on the very next pass — a hot loop against a provider that
  // just told us to slow down.
  const outcomes = ["success", "rate_limited", "failure"] as const;
  for (const outcome of outcomes) {
    const r = nextSyncAttempt({ outcome, retryAfterMs: null, failureCount: 0, now: NOW });
    assert(`${outcome} schedules strictly in the future`, r.nextSyncDueAt.getTime() > NOW, `${waitMs(r)}ms`);
  }
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
