import { planAudience, type SignupRow } from "@/lib/businessModel/audience";

// M8 — the acceptance suite. No database, no environment:
//
//   npx tsx scripts/verify-audience.ts
//
// Two rules carry this milestone: a subscriber is never a customer, and zero
// signups is an absence of evidence rather than evidence of no interest. The
// second matters more than it looks — an owner told "no interest" by their own
// business partner, on the strength of an empty table, is being given a
// conclusion the data cannot support.

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${e}\n        actual   ${a}`);
}

function assert(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

const NOW = new Date("2026-08-19T12:00:00.000Z");
const daysAgo = (n: number): SignupRow => ({ createdAt: new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000) });
const plan = (signups: SignupRow[]) => planAudience({ signups, now: NOW });

// ---------------------------------------------------------------------------
console.log("\nT1. Real signups are reported from real rows");
{
  const a = plan([daysAgo(30), daysAgo(2), daysAgo(11)]);
  check("the real total", a.subscriberCount, 3);
  check("the first one", a.firstSignupAt, "2026-07-20T12:00:00.000Z");
  check("the most recent", a.mostRecentSignupAt, "2026-08-17T12:00:00.000Z");
  check("days since the last one", a.daysSinceMostRecent, 2);
  check(
    "timestamps newest first",
    a.recentSignupsAt,
    ["2026-08-17T12:00:00.000Z", "2026-08-08T12:00:00.000Z", "2026-07-20T12:00:00.000Z"]
  );
}

// ---------------------------------------------------------------------------
console.log("\nT2. Nobody yet is an absence of evidence, not evidence of no interest");
{
  const a = plan([]);
  check("a real zero", a.subscriberCount, 0);
  check("no invented first date", a.firstSignupAt, null);
  check("no invented last date", a.mostRecentSignupAt, null);
  check("no timestamps", a.recentSignupsAt, []);
  check("and days-since is null, not 0", a.daysSinceMostRecent, null);
  // 0 days since would read as "someone signed up today".
  assert("an empty table never implies a recent signup", a.daysSinceMostRecent !== 0);
}

// ---------------------------------------------------------------------------
console.log("\nT3. No email address ever leaves the database");
{
  const a = plan([daysAgo(1), daysAgo(4)]);
  const serialized = JSON.stringify(a);
  check("nothing that looks like an address", serialized.includes("@"), false);
  check(
    "and no field could hold one",
    Object.keys(a).filter((k) => /email|address|subscriber(s)?$|contact/i.test(k)),
    []
  );
  check(
    "the shape is exactly counts and timestamps",
    Object.keys(a).sort(),
    ["daysSinceMostRecent", "firstSignupAt", "mostRecentSignupAt", "recentSignupsAt", "subscriberCount"]
  );
}

// ---------------------------------------------------------------------------
console.log("\nT4. A subscriber is never a customer");
{
  const a = plan([daysAgo(1), daysAgo(2), daysAgo(3)]);
  const keys = Object.keys(a).join(" ").toLowerCase();
  check(
    "no field claims a purchase, order or revenue",
    ["customer", "order", "revenue", "purchase", "sale", "spent"].filter((w) => keys.includes(w)),
    []
  );
  // The count stands alone: nothing here can be added to an order count or a
  // contact list without someone deliberately doing so elsewhere.
  check("the count is subscribers only", a.subscriberCount, 3);
}

// ---------------------------------------------------------------------------
console.log("\nT5. Timing is computed, never estimated");
{
  check("a signup hours ago is zero days", plan([{ createdAt: new Date(NOW.getTime() - 3 * 60 * 60 * 1000) }]).daysSinceMostRecent, 0);
  check("a day-old signup is one", plan([daysAgo(1)]).daysSinceMostRecent, 1);
  check("a year-old signup is real", plan([daysAgo(365)]).daysSinceMostRecent, 365);
  // Clock skew must never produce a negative age.
  check(
    "a future-dated signup never goes negative",
    planAudience({ signups: [{ createdAt: new Date(NOW.getTime() + 60 * 60 * 1000) }], now: NOW }).daysSinceMostRecent,
    0
  );
  // Input order must not change the answer.
  check("unsorted input yields the same first date", plan([daysAgo(2), daysAgo(40), daysAgo(9)]).firstSignupAt, plan([daysAgo(40), daysAgo(9), daysAgo(2)]).firstSignupAt);
}

// ---------------------------------------------------------------------------
console.log("\nT6. The timestamp list is capped without making the count wrong");
{
  const many = Array.from({ length: 50 }, (_, i) => daysAgo(i + 1));
  const a = plan(many);
  check("the count is the real total", a.subscriberCount, 50);
  check("the list is bounded", a.recentSignupsAt.length, 20);
  check("and it holds the newest ones", a.recentSignupsAt[0], "2026-08-18T12:00:00.000Z");
  // The first signup is still the real oldest, not the oldest of the capped list.
  check("first signup is the true oldest, not the list's", a.firstSignupAt, "2026-06-30T12:00:00.000Z");
}

// ---------------------------------------------------------------------------
console.log("\nT7. No rate, threshold or judgment is encoded");
{
  const slow = plan([daysAgo(200), daysAgo(400)]);
  const fast = plan([daysAgo(1), daysAgo(1), daysAgo(2), daysAgo(2)]);
  const words = ["rate", "perweek", "permonth", "growth", "trend", "slow", "healthy", "good", "low", "declining"];
  for (const [label, a] of [["a quiet store", slow], ["a busy store", fast]] as const) {
    check(
      `${label} carries no judgment`,
      Object.keys(a).filter((k) => words.some((w) => k.toLowerCase().includes(w))),
      []
    );
  }
  // Both are reported in exactly the same shape — only the numbers differ.
  check("both have identical shape", Object.keys(slow).sort(), Object.keys(fast).sort());
  check("a quiet store still reports its real figures", [slow.subscriberCount, slow.daysSinceMostRecent], [2, 200]);
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
