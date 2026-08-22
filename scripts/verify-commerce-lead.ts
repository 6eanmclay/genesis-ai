import { buildCommerceLead } from "@/lib/dashboard/commerceLead";
import type { OwnerBriefingChangeSet } from "@/lib/dashboard/genesisBriefingComposer";

// COMMERCE'S LEAD — "what changed since you were last here":
//
//   npx tsx scripts/verify-commerce-lead.ts
//
// The last piece of the locked room architecture. Each room has a lead, a
// density and a ground; Commerce's ground and density shipped with the room
// work, and this is its lead.
//
// THE HONEST-ABSENCE RULE IS THE SHAPE OF THE WHOLE FUNCTION, and it is why
// OwnerBriefingChangeSet carries hasPriorAnchor at all. ARCHITECTURE.md states
// it plainly: "two silences are not the same silence."
//
//   no prior anchor   ->  null. Genesis has never briefed this store, so there
//                         is no "since" to speak of. "Nothing has changed" would
//                         be a claim about a period that does not exist.
//   anchor, no change ->  a real, quiet sentence. "Nothing new" is TRUE here.
//   anchor, changes   ->  the counts.
//
// Collapse the first two and Genesis greets a brand-new owner by telling them
// nothing has happened in a business it has never once looked at.
//
// AND REVENUE ONLY APPEARS BEHIND REAL ORDERS. A revenue delta with no orders
// under it is a refund, an adjustment or a correction — none of which is "since
// you were last here" news, and all of which read as a gain if stated alone.

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

const changeSet = (over: Partial<OwnerBriefingChangeSet> = {}): OwnerBriefingChangeSet => ({
  hasPriorAnchor: true,
  sinceIso: "2026-08-21T09:00:00.000Z",
  orderCount: 0,
  revenueDeltaInCents: 0,
  newCustomerCount: 0,
  recentBusinessEvents: [],
  ...over,
});

const lead = (over: Partial<OwnerBriefingChangeSet> = {}, currency = "USD") =>
  buildCommerceLead(changeSet(over), currency);

// ============================================================================
console.log("\n=== 1. A business Genesis has never briefed gets no lead ===\n");
// ============================================================================
check("no prior anchor means no line at all", lead({ hasPriorAnchor: false }), null);
assert(
  "so a brand-new owner is never told nothing has happened",
  lead({ hasPriorAnchor: false }) === null,
  "there is no period to make a claim about — that is a different fact from an empty one"
);
// Even with real activity, an absent anchor means there is no "since" to
// measure it from. The counts belong to the room below, not to a lead that
// cannot say what window they fall in.
check("even with orders on the board",
  lead({ hasPriorAnchor: false, orderCount: 4, revenueDeltaInCents: 12_000 }), null);

// ============================================================================
console.log("\n=== 2. A quiet spell is said out loud ===\n");
// ============================================================================
const quiet = lead();
assert("an anchor with nothing since it still gets a line", quiet !== null, String(quiet));
check("which says nothing is new", quiet?.text, "Nothing new since you were last here.");
check("and is marked quiet, so the room can render it softly", quiet?.quiet, true);
assert(
  "which is a different outcome from having no anchor at all",
  quiet !== null && lead({ hasPriorAnchor: false }) === null,
  "two silences are not the same silence"
);

// ============================================================================
console.log("\n=== 3. The counts, in the words a shopkeeper uses ===\n");
// ============================================================================
check("one order reads as one", lead({ orderCount: 1 })?.text,
  "Since you were last here: 1 new order.");
check("several read as several", lead({ orderCount: 3 })?.text,
  "Since you were last here: 3 new orders.");
check("one customer too", lead({ newCustomerCount: 1 })?.text,
  "Since you were last here: 1 new customer.");
check("orders and customers join up",
  lead({ orderCount: 2, newCustomerCount: 1 })?.text,
  "Since you were last here: 2 new orders and 1 new customer.");
check("and all three make a list",
  lead({ orderCount: 2, revenueDeltaInCents: 8400, newCustomerCount: 1 })?.text,
  "Since you were last here: 2 new orders, $84 in revenue and 1 new customer.");

for (const l of [lead({ orderCount: 1 }), lead({ orderCount: 2, newCustomerCount: 3 })]) {
  assert("a lead with real news is not marked quiet", l?.quiet === false, JSON.stringify(l));
  assert("and ends as a sentence does", l?.text.endsWith(".") ?? false, String(l?.text));
}

// ============================================================================
console.log("\n=== 4. Revenue only ever appears behind real orders ===\n");
// ============================================================================
// A delta with no orders under it is a refund, an adjustment or a correction.
check("revenue with no orders is not reported",
  lead({ revenueDeltaInCents: 15_000 })?.text, "Nothing new since you were last here.");
assert(
  "so an adjustment is never announced as money the business took",
  lead({ revenueDeltaInCents: 15_000 })?.quiet === true,
  "a refund stated alone reads as a gain"
);
check("a negative delta is never shown either",
  lead({ orderCount: 1, revenueDeltaInCents: -5_000 })?.text,
  "Since you were last here: 1 new order.");
check("nor a zero one", lead({ orderCount: 1, revenueDeltaInCents: 0 })?.text,
  "Since you were last here: 1 new order.");

// ============================================================================
console.log("\n=== 5. A figure is in the money the owner actually takes ===\n");
// ============================================================================
check("pounds for a GBP business",
  lead({ orderCount: 1, revenueDeltaInCents: 4_250 }, "GBP")?.text,
  "Since you were last here: 1 new order and £43 in revenue.");
check("euros for a EUR one",
  lead({ orderCount: 1, revenueDeltaInCents: 4_250 }, "EUR")?.text,
  "Since you were last here: 1 new order and €43 in revenue.");
check("dollars by default",
  lead({ orderCount: 1, revenueDeltaInCents: 4_250 }, "USD")?.text,
  "Since you were last here: 1 new order and $43 in revenue.");
assert(
  "never a currency the store does not trade in",
  !(lead({ orderCount: 1, revenueDeltaInCents: 100 }, "GBP")?.text.includes("$") ?? true),
  "a figure in the wrong currency is a wrong figure"
);

// A headline figure carries no pennies — this is a glance, not a ledger row.
check("a large figure is grouped and rounded",
  lead({ orderCount: 9, revenueDeltaInCents: 1_234_567 })?.text.includes("$12,346"), true);

// ============================================================================
console.log("\n=== 6. It reports, it never retells ===\n");
// ============================================================================
// The same discipline buildBriefing holds: the orders, customers and revenue
// are all one scroll below this line. A lead that quoted them would be a
// summary of what the owner is already looking at.
const withEvents = lead({
  orderCount: 1,
  recentBusinessEvents: [
    { summary: "ZZEVENTTEXT an invoice was paid", occurredAt: "2026-08-21T10:00:00.000Z" },
  ],
});
assert("the lead quotes no event text", !withEvents?.text.includes("ZZEVENTTEXT"), String(withEvents?.text));
assert("and names no customer or product", !/@|Tensor|Copper/.test(withEvents?.text ?? ""),
  String(withEvents?.text));
assert("it is one sentence, not a list of rows",
  (withEvents?.text.match(/\./g) ?? []).length === 1, String(withEvents?.text));

console.log(`\n${failures === 0 ? "All commerce-lead assertions passed." : `${failures} assertion(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
