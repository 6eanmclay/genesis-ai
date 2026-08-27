import {
  priceOrder,
  distributeProportionally,
  type DiscountCandidate,
} from "@/lib/pricing/orderPricing";
import {
  resolveSelection,
  describeSelection,
  selectionProblem,
  listNames,
} from "@/lib/products/selection";

// MANY LINES, AND WHICH PRODUCTS THE MERCHANT MEANT:
//
//   npx tsx scripts/verify-pricing-lines.ts
//
// Standalone — no database, no network. Both modules are pure, which is why
// they are built first: the bag and J4 get rendered on top of them, and a
// foundation that is only exercised through a UI is a foundation nobody can
// check.
//
// THE ACCEPTANCE TEST FOR THE PRICING HALF IS NOT IN THIS FILE. It is that
// scripts/verify-promotions.ts still passes all 150 of its assertions with not
// one character edited — a one-line bag IS the checkout that has been taking
// real money, and if the two ever disagree the multi-line work is wrong. This
// file covers what that suite cannot: what happens with more than one product.

let failures = 0;
function assert(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  -- ${detail}` : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(name, ok, ok ? "" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const sale = (id: string, label: string, percentOff: number): DiscountCandidate => ({
  kind: "SALE", promotionId: id, label, code: null,
  discountType: "PERCENTAGE", percentOff, amountOffInCents: null,
});
const code = (id: string, label: string, percentOff: number): DiscountCandidate => ({
  kind: "CODE", promotionId: id, label, code: label,
  discountType: "PERCENTAGE", percentOff, amountOffInCents: null,
});
const flatCode = (id: string, label: string, amountOffInCents: number): DiscountCandidate => ({
  kind: "CODE", promotionId: id, label, code: label,
  discountType: "FIXED_AMOUNT", percentOff: null, amountOffInCents,
});

console.log("\n=== 1. A bag is priced line by line ===\n");

const bag = priceOrder({
  lines: [
    { productId: "ring", unitPriceInCents: 2400, quantity: 2 },
    { productId: "coil", unitPriceInCents: 5000, quantity: 1 },
  ],
});
eq("each line multiplies out", bag.lines.map((l) => l.listInCents), [4800, 5000]);
eq("the subtotal is their sum", bag.listSubtotalInCents, 9800);
eq("nothing discounted means nothing off", bag.discountInCents, 0);
eq("and no promotion recorded", bag.discount, null);
eq("the total is the subtotal", bag.totalInCents, 9800);

// THE COMPATIBILITY THAT THE 150 ASSERTIONS DEPEND ON, asserted here too so it
// is stated rather than merely true.
const single = priceOrder({ unitPriceInCents: 2400, candidates: [sale("s1", "Spring", 15)] });
const asLine = priceOrder({ lines: [{ unitPriceInCents: 2400, candidates: [sale("s1", "Spring", 15)] }] });
eq("the single-product shape and a one-line bag are the same order",
  JSON.stringify(single), JSON.stringify(asLine));
eq("CONTROL: and it is the answer the old checkout gave", single.totalInCents, 2040);

console.log("\n=== 2. A selective sale reaches only the lines it covers ===\n");

const spring = sale("spring", "Spring Sale", 26);
const selective = priceOrder({
  lines: [
    { productId: "ring", unitPriceInCents: 3500, quantity: 1, candidates: [spring] },
    { productId: "shirt", unitPriceInCents: 2500, quantity: 1, candidates: [] },
  ],
});
eq("the covered line is discounted", selective.lines[0].discountInCents, 910);
eq("and reads as the sale price", selective.lines[0].subtotalInCents, 2590);
eq("the uncovered line is untouched", selective.lines[1].discountInCents, 0);
eq("total off is only the covered line's", selective.discountInCents, 910);
eq("and the order total reflects exactly that", selective.totalInCents, 3500 + 2500 - 910);
eq("one promotion did it, so it is named", selective.discount?.promotionId, "spring");
eq("with the whole amount, not one line's", selective.discount?.amountInCents, 910);
eq("and it is listed once", selective.appliedPromotionIds, ["spring"]);

// Quantity is not decoration: two of a discounted item is twice the discount.
const two = priceOrder({
  lines: [{ productId: "ring", unitPriceInCents: 3500, quantity: 2, candidates: [spring] }],
});
eq("a quantity of two doubles the line", two.lines[0].listInCents, 7000);
eq("and doubles what comes off", two.discountInCents, 1820);

console.log("\n=== 3. Sales and codes compete. They never compound. ===\n");

// Sale takes 26% of one line; the code takes 10% of everything.
const both = priceOrder({
  lines: [
    { productId: "ring", unitPriceInCents: 3500, quantity: 1, candidates: [spring] },
    { productId: "shirt", unitPriceInCents: 2500, quantity: 1, candidates: [] },
  ],
  orderCandidates: [code("save10", "SAVE10", 10)],
});
// sales = 910; code = 10% of 6000 = 600. Sales win.
eq("the better of the two wins outright", both.discountInCents, 910);
eq("and it is the sale", both.discount?.kind, "SALE");
assert("the code is not applied on top",
  both.discountInCents === 910,
  "stacking would have taken 910 + 600 = 1510");
eq("CONTROL: and the code left no trace on any line",
  both.lines.every((l) => l.discount === null || l.discount.kind === "SALE"), true);

// Now make the code better than the sale.
const codeWins = priceOrder({
  lines: [
    { productId: "ring", unitPriceInCents: 3500, quantity: 1, candidates: [spring] },
    { productId: "shirt", unitPriceInCents: 2500, quantity: 1, candidates: [] },
  ],
  orderCandidates: [code("half", "HALF", 50)],
});
eq("a better code wins instead", codeWins.discountInCents, 3000);
eq("and it is the code", codeWins.discount?.kind, "CODE");
assert("the sale is dropped entirely rather than kept underneath",
  codeWins.discountInCents === 3000,
  "keeping both would have taken 3000 + 910");

// A tie goes to the standing sale, matching the single-product rule.
const tie = priceOrder({
  lines: [{ unitPriceInCents: 1000, candidates: [sale("s", "Sale", 10)] }],
  orderCandidates: [code("c", "CODE", 10)],
});
eq("a tie goes to the sale", tie.discount?.kind, "SALE");

console.log("\n=== 4. A code is recorded on every line it touched ===\n");

// An OrderItem that cannot say what it cost is not a record of anything.
const spread = priceOrder({
  lines: [
    { productId: "a", unitPriceInCents: 3000, quantity: 1 },
    { productId: "b", unitPriceInCents: 2000, quantity: 1 },
  ],
  orderCandidates: [code("c", "SAVE10", 10)],
});
eq("the code is split across the lines", spread.lines.map((l) => l.discountInCents), [300, 200]);
eq("and the shares sum to the discount",
  spread.lines.reduce((s, l) => s + l.discountInCents, 0), spread.discountInCents);
eq("each line names the code that discounted it",
  spread.lines.map((l) => l.discount?.label), ["SAVE10", "SAVE10"]);
eq("carrying that line's share, not the whole amount",
  spread.lines.map((l) => l.discount?.amountInCents), [300, 200]);

// ROUNDING IS THE PART THAT GOES WRONG QUIETLY.
const awkward = priceOrder({
  lines: [
    { productId: "a", unitPriceInCents: 333, quantity: 1 },
    { productId: "b", unitPriceInCents: 333, quantity: 1 },
    { productId: "c", unitPriceInCents: 333, quantity: 1 },
  ],
  orderCandidates: [flatCode("c", "TENOFF", 10)],
});
eq("an indivisible discount still sums exactly",
  awkward.lines.reduce((s, l) => s + l.discountInCents, 0), 10);
assert("because line subtotals that do not add up to the charge appear on a receipt",
  awkward.lines.reduce((s, l) => s + l.subtotalInCents, 0) === awkward.merchandiseSubtotalInCents);

eq("nothing to split is all zeroes", distributeProportionally(0, [10, 20]), [0, 0]);
eq("no weight to split across is all zeroes", distributeProportionally(100, [0, 0]), [0, 0]);
eq("an exact split is exact", distributeProportionally(100, [50, 50]), [50, 50]);
eq("and a remainder lands on the largest line", distributeProportionally(10, [70, 30]), [7, 3]);
eq("a single cent goes somewhere rather than nowhere",
  distributeProportionally(1, [50, 50]).reduce((a, b) => a + b, 0), 1);
// A share can never exceed the line it is taken from.
const capped = distributeProportionally(100, [10, 5]);
assert("no line is discounted past its own value", capped[0] <= 10 && capped[1] <= 5);

console.log("\n=== 5. Several sales, and the honest refusal to name one ===\n");

const mixed = priceOrder({
  lines: [
    { productId: "ring", unitPriceInCents: 4000, quantity: 1, candidates: [sale("rings", "Ring Sale", 25)] },
    { productId: "mug", unitPriceInCents: 2000, quantity: 1, candidates: [sale("mugs", "Mug Sale", 10)] },
  ],
});
eq("each line takes its own sale", mixed.lines.map((l) => l.discountInCents), [1000, 200]);
eq("and the order records the total", mixed.discountInCents, 1200);
// NAMING ONE OF TWO WOULD BE PICKING A WINNER THAT DOES NOT EXIST.
eq("no single promotion is claimed", mixed.discount, null);
eq("but both are listed", mixed.appliedPromotionIds, ["rings", "mugs"]);
eq("and each line still says which one discounted it",
  mixed.lines.map((l) => l.discount?.promotionId), ["rings", "mugs"]);
assert("so an order with a mixed bag still attributes every cent",
  mixed.lines.reduce((s, l) => s + (l.discount?.amountInCents ?? 0), 0) === mixed.discountInCents);

// One sale covering several lines is still ONE promotion, and is named.
const storewide = priceOrder({
  lines: [
    { productId: "a", unitPriceInCents: 1000, quantity: 1, candidates: [spring] },
    { productId: "b", unitPriceInCents: 2000, quantity: 1, candidates: [spring] },
  ],
});
eq("a store-wide sale is one promotion", storewide.appliedPromotionIds, ["spring"]);
eq("so it is named on the order", storewide.discount?.promotionId, "spring");
eq("with the whole amount", storewide.discount?.amountInCents, 260 + 520);

console.log("\n=== 6. The structural rules survive many lines ===\n");

// SHIPPING IS NEVER DISCOUNTED.
const shipped = priceOrder({
  lines: [
    { unitPriceInCents: 3500, quantity: 1, candidates: [spring] },
    { unitPriceInCents: 2500, quantity: 1, candidates: [spring] },
  ],
  shippingInCents: 892,
});
eq("shipping passes through at full price", shipped.shippingInCents, 892);
eq("the discount comes off the goods only", shipped.discountInCents, 910 + 650);
eq("and the total is discounted goods plus full shipping",
  shipped.totalInCents, 6000 - 1560 + 892);

// NEVER NEGATIVE, per line and in total.
const wiped = priceOrder({
  lines: [
    { unitPriceInCents: 1000, quantity: 1, candidates: [sale("s", "Everything", 100)] },
    { unitPriceInCents: 2000, quantity: 1, candidates: [sale("s", "Everything", 100)] },
  ],
  shippingInCents: 500,
});
eq("a 100% sale lands every line on zero", wiped.lines.map((l) => l.subtotalInCents), [0, 0]);
eq("and the merchandise subtotal on zero", wiped.merchandiseSubtotalInCents, 0);
eq("with shipping still owed", wiped.totalInCents, 500);

const huge = priceOrder({
  lines: [{ unitPriceInCents: 1000, quantity: 1 }],
  orderCandidates: [flatCode("c", "BIG", 999999)],
});
eq("a code larger than the bag takes exactly the bag", huge.discountInCents, 1000);
eq("and the total is zero, never below", huge.totalInCents, 0);

// An empty bag is a real state, not a crash.
const empty = priceOrder({ lines: [] });
eq("an empty bag has no lines", empty.lines, []);
eq("no subtotal", empty.listSubtotalInCents, 0);
eq("and no total", empty.totalInCents, 0);
eq("a code against an empty bag takes nothing",
  priceOrder({ lines: [], orderCandidates: [code("c", "SAVE", 50)] }).discountInCents, 0);

console.log("\n=== 7. Which products the merchant meant ===\n");

const CATALOGUE = [
  { name: "Sacred Cubit Copper Tensor Ring" },
  { name: "Copper Tensor Ring Cuff Bracelet" },
  { name: "177Hz Copper Tensor Ring Pyramid" },
  { name: "Cubit & Coil T-Shirt" },
  { name: "Cubit & Coil Hoodie" },
  { name: "Copper Mug" },
];

// THE SENTENCE THIS WHOLE MODULE EXISTS FOR.
const everythingExcept = resolveSelection(CATALOGUE, {
  include: { kind: "all" },
  exclude: { kind: "named", names: ["Cubit & Coil T-Shirt", "Cubit & Coil Hoodie", "Copper Mug"] },
});
eq("everything except three leaves three",
  everythingExcept.matched.map((p) => p.name),
  ["Sacred Cubit Copper Tensor Ring", "Copper Tensor Ring Cuff Bracelet", "177Hz Copper Tensor Ring Pyramid"]);
eq("and names what it left out",
  everythingExcept.excluded.map((p) => p.name),
  ["Cubit & Coil T-Shirt", "Cubit & Coil Hoodie", "Copper Mug"]);
assert("nothing was unresolved, so it can be acted on", everythingExcept.resolved);
eq("and there is no question to ask", selectionProblem(everythingExcept), null);

eq("a named include selects only those",
  resolveSelection(CATALOGUE, { include: { kind: "named", names: ["Copper Mug"] } }).matched.map((p) => p.name),
  ["Copper Mug"]);
eq("case and spacing do not matter",
  resolveSelection(CATALOGUE, { include: { kind: "named", names: ["  copper   mug "] } }).matched.map((p) => p.name),
  ["Copper Mug"]);

console.log("\n=== 8. A name that matches nothing is a question, not a silence ===\n");

// THE DEFECT THIS PREVENTS: the merchant protects a product that does not
// exist, and the sale quietly covers everything.
const missingMug = resolveSelection(CATALOGUE.slice(0, 5), {
  include: { kind: "all" },
  exclude: { kind: "named", names: ["Copper Mug"] },
});
eq("the unmatched name is reported", missingMug.unmatched, ["Copper Mug"]);
assert("and the selection refuses to call itself resolved", !missingMug.resolved);
assert("with a question naming what could not be found",
  (selectionProblem(missingMug) ?? "").includes("Copper Mug"));
assert("CONTROL: because otherwise the sale silently covers everything",
  missingMug.matched.length === 5,
  "the products are still there — what changes is that this is not presented as correct");

const ambiguous = resolveSelection(CATALOGUE, { include: { kind: "named", names: ["Tensor Ring"] } });
eq("a name matching several is ambiguous, not a guess", ambiguous.matched, []);
eq("and the candidates are named", ambiguous.ambiguous[0]?.candidates.length, 3);
assert("with a question the merchant can answer",
  (selectionProblem(ambiguous) ?? "").includes("Which did you mean?"));

// EXACT BEATS CONTAINMENT, or naming a product precisely would be ambiguous
// whenever a longer name contained it.
const exactWins = resolveSelection(
  [{ name: "Copper Mug" }, { name: "Copper Mug Warmer" }],
  { include: { kind: "named", names: ["Copper Mug"] } }
);
eq("an exact name wins over a longer one containing it",
  exactWins.matched.map((p) => p.name), ["Copper Mug"]);
assert("and is not reported ambiguous", exactWins.resolved);

// A partial name that reaches exactly one product is a real selection.
eq("a partial name matching one product resolves",
  resolveSelection(CATALOGUE, { include: { kind: "named", names: ["Hoodie"] } }).matched.map((p) => p.name),
  ["Cubit & Coil Hoodie"]);

// Excluding something never included is not an exclusion.
const outsideScope = resolveSelection(CATALOGUE, {
  include: { kind: "named", names: ["Copper Mug"] },
  exclude: { kind: "named", names: ["Cubit & Coil Hoodie"] },
});
eq("the selection is unaffected", outsideScope.matched.map((p) => p.name), ["Copper Mug"]);
eq("and nothing is claimed to have been left out", outsideScope.excluded, []);

// Two names for one product select it once.
eq("duplicate names do not duplicate a product",
  resolveSelection(CATALOGUE, { include: { kind: "named", names: ["Copper Mug", "copper mug"] } }).matched.length, 1);

console.log("\n=== 9. What the merchant is shown to check ===\n");

eq("a small selection is named outright",
  describeSelection(resolveSelection(CATALOGUE, { include: { kind: "named", names: ["Copper Mug"] } }),
    { totalProducts: 6 }),
  "Copper Mug");
// AT OR UNDER THE LIMIT, NAME THEM. Three names is checkable; that is the
// whole purpose of the sentence.
eq("a short selection is named even when something was left out",
  describeSelection(everythingExcept, { totalProducts: 6 }),
  "Sacred Cubit Copper Tensor Ring, Copper Tensor Ring Cuff Bracelet and 177Hz Copper Tensor Ring Pyramid, "
    + "leaving out Cubit & Coil T-Shirt, Cubit & Coil Hoodie and Copper Mug");

// OVER IT, COUNT THEM — thirteen names in a row is not checkable either.
const many = Array.from({ length: 16 }, (_, i) => ({ name: `Ring ${i + 1}` }));
eq("a long selection is counted, with what was left out named",
  describeSelection(
    resolveSelection(many, { include: { kind: "all" }, exclude: { kind: "named", names: ["Ring 1"] } }),
    { totalProducts: 16 }
  ),
  "15 products, leaving out Ring 1");
eq("and a long exclusion is counted too",
  describeSelection(
    resolveSelection(many, {
      include: { kind: "all" },
      exclude: { kind: "named", names: ["Ring 1", "Ring 2", "Ring 3", "Ring 4"] },
    }),
    { totalProducts: 16 }
  ),
  "12 products, leaving out 4 others");
eq("everything is said to be everything",
  describeSelection(resolveSelection(CATALOGUE, { include: { kind: "all" } }), { totalProducts: 6 }),
  "all 6 products");
eq("and nothing is said to be nothing",
  describeSelection(resolveSelection(CATALOGUE, { include: { kind: "named", names: [] } }), { totalProducts: 6 }),
  "No products match that.");

eq("one name", listNames(["A"]), "A");
eq("two names", listNames(["A", "B"]), "A and B");
eq("three names", listNames(["A", "B", "C"]), "A, B and C");
eq("no names", listNames([]), "");

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} assertion(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
