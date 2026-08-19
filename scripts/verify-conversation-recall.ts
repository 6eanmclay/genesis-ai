import {
  rankStatements,
  OWNER_MESSAGE_ROLE,
  type StatementRow,
} from "@/lib/businessModel/conversationRecall";

// M9 — the acceptance suite. No database, no environment:
//
//   npx tsx scripts/verify-conversation-recall.ts
//
// The two claims Sean set: an old relevant statement CAN be retrieved, and an
// irrelevant historical statement CANNOT. Everything else here defends the rule
// that makes both true at once — recency ranks, and never gates.

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
const daysAgo = (n: number, content: string): StatementRow => ({
  content,
  createdAt: new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000),
});

const rank = (statements: StatementRow[], query: string, limit = 5) =>
  rankStatements({ statements, query, now: NOW, limit });

// A realistic history: one important thing said long ago, surrounded by noise.
const SUPPLIER = daysAgo(200, "My wax supplier raised prices 12% this month, which is going to squeeze the candle margins.");
const HISTORY: StatementRow[] = [
  SUPPLIER,
  daysAgo(180, "Can you make the hero image a bit warmer?"),
  daysAgo(60, "I want to add a gift set before the holidays."),
  daysAgo(3, "What did I make last week?"),
];

// ---------------------------------------------------------------------------
console.log("\nT1. An old relevant statement is retrieved, far beyond the 50-message window");
{
  const results = rank(HISTORY, "what did my wax supplier do about prices");
  assert("something is recalled", results.length > 0, `${results.length} results`);
  check("it is the supplier statement", results[0]?.text, SUPPLIER.content);
  check("with its real age", results[0]?.ageDays, 200);
  check("and its real timestamp", results[0]?.saidAt, "2026-01-31T12:00:00.000Z");
  assert("carrying real relevance", (results[0]?.relevance ?? 0) > 0.12, `${results[0]?.relevance}`);
}

// ---------------------------------------------------------------------------
console.log("\nT2. An irrelevant historical statement is never returned");
{
  // Asking about the supplier must not drag in the hero or the gift set.
  const results = rank(HISTORY, "what did my wax supplier do about prices");
  check(
    "exactly one statement comes back, and it is the supplier one",
    results.map((r) => r.text),
    [SUPPLIER.content]
  );

  // And a question about something never discussed returns nothing at all.
  check("a question about something never mentioned returns nothing", rank(HISTORY, "how are my instagram followers doing"), []);
  check("as does an unrelated topic entirely", rank(HISTORY, "shipping carrier tracking numbers"), []);
}

// ---------------------------------------------------------------------------
console.log("\nT3. Recency ranks but never gates");
{
  const recentWeak = daysAgo(1, "Prices look fine on the site.");
  const results = rank([recentWeak, SUPPLIER], "wax supplier prices raised");
  check("the older, more relevant statement wins", results[0]?.text, SUPPLIER.content);
  check("its age did not disqualify it", results[0]?.ageDays, 200);

  // Same relevance, different age: the newer one leads.
  const older = daysAgo(300, "The gift set idea keeps coming back.");
  const newer = daysAgo(10, "The gift set idea keeps coming back.");
  const tie = rank([older, newer], "gift set idea");
  check("with equal relevance, the newer one leads", tie[0]?.ageDays, 10);
  check("but the older is still returned, not dropped", tie.length, 2);

  // The nudge is small enough that it cannot outrank real relevance.
  const veryOldStrong = daysAgo(1000, "My wax supplier raised prices twelve percent.");
  const freshWeak = daysAgo(0, "Supplier.");
  const ordered = rank([freshWeak, veryOldStrong], "wax supplier raised prices");
  check("a three-year-old strong match still leads a fresh weak one", ordered[0]?.ageDays, 1000);
}

// ---------------------------------------------------------------------------
console.log("\nT4. Owner messages only");
{
  // The filter is what keeps J4's own words out of the evidence. Asserted
  // directly, because the scorer itself has no notion of role — hand it an
  // assistant message and it would happily score it, which is exactly why the
  // query filter is load-bearing rather than incidental.
  check("the query filters to the owner's role", OWNER_MESSAGE_ROLE, "user");
  const j4Words = daysAgo(5, "Your wax supplier raised prices, so I suggested raising the candle price.");
  assert(
    "the scorer would score J4's own words if handed them, so the filter must exist",
    rank([j4Words], "wax supplier prices").length === 1
  );
}

// ---------------------------------------------------------------------------
console.log("\nT5. The owner's wording comes back verbatim");
{
  const fussy = daysAgo(90, "  Honestly? The 12% increase — from Clayworks — was NOT what I expected.  ");
  const results = rank([fussy], "clayworks increase");
  check("byte-identical, including case, punctuation and spacing", results[0]?.text, fussy.content);
  assert("nothing was trimmed", results[0]?.text.startsWith("  ") === true);
  assert("nothing was truncated", results[0]?.text.endsWith("  ") === true);
}

// ---------------------------------------------------------------------------
console.log("\nT6. No history is honest emptiness");
{
  check("nothing to search returns nothing", rank([], "wax supplier"), []);
}

// ---------------------------------------------------------------------------
console.log("\nT7. A query with no real subject returns nothing");
{
  // Stopwords only — there is nothing to match on, and fishing through history
  // would return whatever happened to be longest.
  check("a pure-stopword question does not fish", rank(HISTORY, "what did I say about that again"), []);
  check("an empty query returns nothing", rank(HISTORY, ""), []);
  check("punctuation alone returns nothing", rank(HISTORY, "???"), []);
}

// ---------------------------------------------------------------------------
console.log("\nT8. Results are bounded and deterministically ordered");
{
  const many = Array.from({ length: 40 }, (_, i) => daysAgo(i + 1, `The gift set idea number ${i}`));
  check("the batch is capped", rank(many, "gift set idea", 5).length, 5);
  check(
    "and the same inputs give the same order",
    rank(many, "gift set idea", 5).map((r) => r.saidAt),
    rank([...many].reverse(), "gift set idea", 5).map((r) => r.saidAt)
  );
}

// ---------------------------------------------------------------------------
console.log("\nT9. Age is computed and never negative");
{
  check("a statement from hours ago is zero days", rank([daysAgo(0, "wax supplier update")], "wax supplier")[0]?.ageDays, 0);
  const future: StatementRow = { content: "wax supplier update", createdAt: new Date(NOW.getTime() + 3600_000) };
  check("a future-dated row never reports negative age", rankStatements({ statements: [future], query: "wax supplier", now: NOW })[0]?.ageDays, 0);
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
