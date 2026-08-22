import { parseCardEconomicsAnswer, replyFor } from "@/lib/sourcing/economicsChat";
import type { OutstandingQuestion } from "@/lib/sourcing/economicsChat";
import type { AnswerResult } from "@/lib/sourcing/economicsAnswer";

// A FIGURE ABOUT SOMEBODY'S MONEY, AND WHAT IS STILL UNKNOWN:
//
//   npx tsx scripts/verify-economics-card.ts
//
// Two pure functions the live economics suites do not reach.
// verify-economics-chat.ts already covers the conversational path end to end —
// chatAnswerFrom, describeOutstandingForJ4, applyEconomicsAnswer — against a
// real database. These two are the CARD path's parser and the reply builder,
// and neither had coverage anywhere.
//
// parseCardEconomicsAnswer says why it exists as a function rather than a few
// lines in a form handler: "parsing is the one place in the card path where a
// figure about somebody's money could be invented — a blank field read as 0, a
// fraction of a unit rounded into existence". Every refusal below is one of
// those inventions not happening.
//
// replyFor carries the subtler rule, and it is the one a generated reply would
// drop: it must always say what was learned AND what is still unknown, because
// "a reply that reports the fact it just recorded without saying the other half
// is still missing is the part of the truth that sounds like all of it, and it
// is how an owner comes away thinking the question is closed when it is not."
//
// The distinction this whole surface turns on: OBSERVED (the owner stated it),
// UNKNOWN (they did not), and REFUSED (the supplier would not say). None of the
// three may be turned into either of the others, and none may become a number.

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

const quoted = (over: { minimumOrderUnits?: string | null; bulkUnitCost?: string | null }) =>
  parseCardEconomicsAnswer({ outcome: "quoted", ...over });

// ============================================================================
console.log("\n=== 1. A blank field is a fact nobody stated ===\n");
// ============================================================================
// The failure this function exists to prevent: an empty box read as zero. A
// minimum order of 0 and a unit cost of £0.00 are both figures, and both are
// wrong in the direction that makes a bad deal look free.
const onlyUnits = quoted({ minimumOrderUnits: "100", bulkUnitCost: "" });
assert("a stated minimum is recorded", onlyUnits.kind === "quoted");
check("as the number they typed",
  onlyUnits.kind === "quoted" ? onlyUnits.minimumOrderUnits : null, 100);
check("while the price they left blank stays unknown",
  onlyUnits.kind === "quoted" ? onlyUnits.bulkUnitCostInCents : "not-quoted", null);
assert("never zero, which would read as free",
  onlyUnits.kind === "quoted" && onlyUnits.bulkUnitCostInCents !== 0);

const onlyPrice = quoted({ minimumOrderUnits: "", bulkUnitCost: "4.10" });
check("a stated price is recorded in cents, exactly once",
  onlyPrice.kind === "quoted" ? onlyPrice.bulkUnitCostInCents : null, 410);
check("while the minimum they left blank stays unknown",
  onlyPrice.kind === "quoted" ? onlyPrice.minimumOrderUnits : "not-quoted", null);

// Absent fields, not just empty strings.
const absent = parseCardEconomicsAnswer({ outcome: "quoted", minimumOrderUnits: "100" });
check("an absent field is unknown too",
  absent.kind === "quoted" ? absent.bulkUnitCostInCents : "not-quoted", null);

// ============================================================================
console.log("\n=== 2. A quantity nobody can order is not a quantity ===\n");
// ============================================================================
check("zero units is not a minimum order",
  quoted({ minimumOrderUnits: "0", bulkUnitCost: "4.10" }).kind === "quoted"
    ? (quoted({ minimumOrderUnits: "0", bulkUnitCost: "4.10" }) as { minimumOrderUnits: number | null }).minimumOrderUnits
    : "not-quoted",
  null);
const fractional = quoted({ minimumOrderUnits: "2.5", bulkUnitCost: "4.10" });
check("nor half a unit",
  fractional.kind === "quoted" ? fractional.minimumOrderUnits : "not-quoted", null);
const negative = quoted({ minimumOrderUnits: "-10", bulkUnitCost: "4.10" });
check("nor a negative one",
  negative.kind === "quoted" ? negative.minimumOrderUnits : "not-quoted", null);
const nonsense = quoted({ minimumOrderUnits: "about a hundred", bulkUnitCost: "4.10" });
check("nor a sentence",
  nonsense.kind === "quoted" ? nonsense.minimumOrderUnits : "not-quoted", null);
assert(
  "and in every case the price they DID state survives",
  [fractional, negative, nonsense].every(
    (a) => a.kind === "quoted" && a.bulkUnitCostInCents === 410
  ),
  "one unusable field must not discard a usable one"
);

// ============================================================================
console.log("\n=== 3. Money as a person actually types it ===\n");
// ============================================================================
const money = (raw: string) => {
  const a = quoted({ minimumOrderUnits: "100", bulkUnitCost: raw });
  return a.kind === "quoted" ? a.bulkUnitCostInCents : "not-quoted";
};
check("a currency symbol is not part of the number", money("$4.10"), 410);
check("nor a pound sign", money("£4.10"), 410);
check("a whole number of pounds is not a whole number of cents", money("4"), 400);
check("surrounding whitespace is ignored", money("  4.10  "), 410);
check("a sub-cent price rounds to the nearest cent", money("4.005"), 401);
check("free is a real, stated price", money("0"), 0);
assert("which is different from a blank field", money("") === null && money("0") === 0,
  "'they told me it is free' and 'they did not say' are different facts");
check("a price that is not a number is unknown", money("ask them"), null);

// ============================================================================
console.log("\n=== 4. An empty answer is not an answer ===\n");
// ============================================================================
// A "quoted" submission with neither field filled is somebody who has not found
// out yet. Recording it as a quote would close a question nobody answered.
const empty = quoted({ minimumOrderUnits: "", bulkUnitCost: "" });
check("submitting a quote with nothing in it is 'not found out yet'", empty.kind, "dont_know_yet");
assert("rather than an empty quote that closes the question",
  empty.kind !== "quoted",
  "an empty quote would look like an answer to everything downstream");

// The same is true of fields that are present but unusable.
const unusable = quoted({ minimumOrderUnits: "0", bulkUnitCost: "not a price" });
check("and so is one where nothing usable was typed", unusable.kind, "dont_know_yet");

// ============================================================================
console.log("\n=== 5. Refused and unknown are different facts ===\n");
// ============================================================================
check("a supplier that would not quote is recorded as refusing",
  parseCardEconomicsAnswer({ outcome: "supplier_would_not_say" }).kind, "supplier_would_not_say");
check("an owner who has not asked yet is recorded as not knowing",
  parseCardEconomicsAnswer({ outcome: "dont_know_yet" }).kind, "dont_know_yet");
assert(
  "and neither carries a figure",
  !("bulkUnitCostInCents" in parseCardEconomicsAnswer({ outcome: "supplier_would_not_say" })) &&
    !("minimumOrderUnits" in parseCardEconomicsAnswer({ outcome: "dont_know_yet" })),
  "a refusal is not a price of zero"
);
// A refusal ignores anything typed into the number fields — the outcome is what
// the owner selected, and it wins.
check("a refusal ignores stray figures",
  parseCardEconomicsAnswer({ outcome: "supplier_would_not_say", minimumOrderUnits: "100", bulkUnitCost: "4.10" }).kind,
  "supplier_would_not_say");

// ============================================================================
console.log("\n=== 6. The reply always says what is still unknown ===\n");
// ============================================================================
const question: OutstandingQuestion = {
  dedupeKey: "economics:printful:tee",
  productId: "p1",
  productName: "the wax melts",
  sourceKey: "printful",
  externalProductId: "tee-1",
  externalVariantId: null,
  gaps: ["minimum_order", "bulk_price"],
};

const result = (over: Partial<AnswerResult>): AnswerResult =>
  ({
    recorded: { status: "recorded", externalProductId: "tee-1", externalVariantId: null, wrote: [], preserved: [] },
    changes: [],
    question: "still_open",
    stillMissing: [],
    nowRecommends: null,
    productId: "p1",
    ...over,
  }) as AnswerResult;

const partial = replyFor(question, result({
  changes: ["minimum_order_became_known"],
  stillMissing: ["bulk_price"],
}));
assert("it says what was learned", partial.includes("how many you have to order"), partial);
assert("AND what is still missing", partial.includes("I still don't know"), partial);
assert("naming the specific gap", partial.includes("what they charge per unit at that quantity"), partial);
assert(
  "so a partial answer never reads as a complete one",
  partial.includes("I still don't know"),
  "the part of the truth that sounds like all of it"
);

// Nothing left missing, so nothing is claimed to be missing.
const complete = replyFor(question, result({ changes: ["bulk_price_became_known"], stillMissing: [] }));
assert("a complete answer does not invent a remaining gap",
  !complete.includes("I still don't know"), complete);

// Recorded, but it matched what was already known. The owner spent effort and
// deserves to know it landed — and deserves not to be told something changed.
const unchanged = replyFor(question, result({ changes: [], stillMissing: ["bulk_price"] }));
assert("a matching answer says nothing changed", unchanged.includes("nothing's changed"), unchanged);
assert("while still naming what is missing", unchanged.includes("I still don't know"), unchanged);

// Nothing written at all keeps the question open, explicitly.
const nothing = replyFor(question, result({ recorded: null, stillMissing: ["minimum_order", "bulk_price"] }));
assert("nothing recorded says so plainly", nothing.includes("haven't written anything down"), nothing);
assert("and says the question stays open", nothing.includes("keep the question open"), nothing);
assert("naming both gaps", nothing.includes("how many") && nothing.includes("what they charge"), nothing);

// A rejection reports the real problem rather than a generic failure.
const rejected = replyFor(question, result({
  recorded: { status: "rejected", problem: "that price is lower than their own bulk tier" } as never,
  stillMissing: ["bulk_price"],
}));
assert("a rejection gives the real reason",
  rejected.includes("lower than their own bulk tier"), rejected);

// A refusal stops asking rather than pretending the figure is pending.
const refused = replyFor(question, result({ changes: ["supplier_refused"], stillMissing: [] }));
assert("a refusal says it will stop asking", refused.includes("stop asking"), refused);
assert("and suggests looking elsewhere", refused.includes("another supplier"), refused);

// A recommendation is only offered when there genuinely is one.
const withRecommendation = replyFor(question, result({
  changes: ["bulk_price_became_known"],
  stillMissing: [],
  nowRecommends: "order 100 and price them at £12",
}));
assert("a real recommendation is passed through",
  withRecommendation.includes("order 100 and price them at £12"), withRecommendation);
assert("and one is never invented when there is none",
  !complete.includes("worth doing"), complete);

// Every reply names the product, so an owner answering several questions can
// tell which one landed.
assert("every reply names the product it is about",
  [partial, complete, unchanged, nothing, rejected, refused].every((r) => r.includes("the wax melts")),
  "an answer about one product must not read as an answer about another");

console.log(`\n${failures === 0 ? "All economics-card assertions passed." : `${failures} assertion(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
