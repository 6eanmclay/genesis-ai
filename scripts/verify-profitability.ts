import {
  summarizeMarginCoverage,
  computeItemMargin,
  planProfitability,
} from "@/lib/businessModel/profitability";

// M5 — the acceptance suite. No database, no environment:
//
//   npx tsx scripts/verify-profitability.ts
//
// The rule every test here exists to hold: a missing cost is never zero, and
// an unknown profit is never $0. Reporting a candle business as pure profit
// because nobody recorded what wax costs would be the single most damaging
// thing this milestone could do.

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

const CANDLE = { id: "p1", name: "Cedar Candle", priceInCents: 3200, costInCents: 1800 };
const UNTRACKED = { id: "p2", name: "Brass Holder", priceInCents: 2400, costInCents: null };

// ---------------------------------------------------------------------------
console.log("\nT1. Store-level margin, with coverage always stated");
{
  const store = summarizeMarginCoverage({ profitInCents: 21200, ordersWithKnownCost: 9, ordersWithUnknownCost: 0 });
  check("real profit is reported", store.profitInCents, 21200);
  check("coverage is complete", store.coverage, "complete");
  check("and the counts are carried", [store.ordersWithKnownCost, store.totalOrders], [9, 9]);
}

// ---------------------------------------------------------------------------
console.log("\nT2. Zero cost-tracked orders is null, never $0");
{
  // getProfitSummary honestly returns 0 here because it summed nothing. Passing
  // that through as "you made $0" would state a fact we do not have.
  const store = summarizeMarginCoverage({ profitInCents: 0, ordersWithKnownCost: 0, ordersWithUnknownCost: 14 });
  check("profit is null", store.profitInCents, null);
  check("coverage says none", store.coverage, "none");
  check("while the real order count is still known", store.totalOrders, 14);
}
{
  // A store with no orders at all — same rule, no special case.
  const store = summarizeMarginCoverage({ profitInCents: 0, ordersWithKnownCost: 0, ordersWithUnknownCost: 0 });
  check("no orders yet also yields null, not zero", store.profitInCents, null);
  check("coverage none", store.coverage, "none");
}

// ---------------------------------------------------------------------------
console.log("\nT3. Partial coverage carries tracked and total counts");
{
  const store = summarizeMarginCoverage({ profitInCents: 8400, ordersWithKnownCost: 6, ordersWithUnknownCost: 3 });
  check("coverage is partial", store.coverage, "partial");
  check("the figure survives", store.profitInCents, 8400);
  check(
    "with both counts, so no bare total can be quoted",
    [store.ordersWithKnownCost, store.ordersWithUnknownCost, store.totalOrders],
    [6, 3, 9]
  );
}

// ---------------------------------------------------------------------------
console.log("\nT4. Per-product margin where cost is known, null where it isn't");
{
  const plan = planProfitability({
    profitSummary: { profitInCents: 8400, ordersWithKnownCost: 6, ordersWithUnknownCost: 3 },
    products: [CANDLE, UNTRACKED],
    performance: [
      { itemId: "internal:item:p1", orderCount: 6, revenueInCents: 19200 },
      { itemId: "internal:item:p2", orderCount: 3, revenueInCents: 7200 },
    ],
  });
  const candle = plan.items.find((i) => i.name === "Cedar Candle");
  const holder = plan.items.find((i) => i.name === "Brass Holder");

  check("a tracked product keeps a real unit margin", candle?.unitMarginInCents, 1400);
  check("as a real ratio", candle?.marginRatio, 0.4375);
  check("and its costKnown flag is true", candle?.costKnown, true);
  check("real units sold, never estimated", [candle?.unitsSold, candle?.revenueInCents], [6, 19200]);

  check("an untracked product has a null margin", holder?.unitMarginInCents, null);
  check("and a null ratio", holder?.marginRatio, null);
  check("flagged so it cannot be read as free", holder?.costKnown, false);
  check("its price is still real", holder?.priceInCents, 2400);
  check("and its cost stays null, never 0", holder?.costInCents, null);
}

// ---------------------------------------------------------------------------
console.log("\nT5. Cost is never inferred");
{
  // Not from price, not from another product, not from a category.
  check("price alone yields nothing", computeItemMargin({ priceInCents: 2400, costInCents: null }), {
    unitMarginInCents: null,
    marginRatio: null,
  });
  check("cost alone yields nothing", computeItemMargin({ priceInCents: null, costInCents: 1800 }), {
    unitMarginInCents: null,
    marginRatio: null,
  });
  check("neither yields nothing", computeItemMargin({ priceInCents: null, costInCents: null }), {
    unitMarginInCents: null,
    marginRatio: null,
  });

  // A tracked product sitting beside an untracked one must not lend it a cost.
  const plan = planProfitability({
    profitSummary: { profitInCents: 1400, ordersWithKnownCost: 1, ordersWithUnknownCost: 0 },
    products: [CANDLE, UNTRACKED],
    performance: [],
  });
  check(
    "a neighbouring known cost does not leak",
    plan.items.find((i) => i.name === "Brass Holder")?.costInCents,
    null
  );
  check(
    "and an unsold product reports zero units rather than guessing",
    plan.items.map((i) => i.unitsSold),
    [0, 0]
  );
}

// ---------------------------------------------------------------------------
console.log("\nT6. The two views cannot contradict each other");
{
  const plan = planProfitability({
    profitSummary: { profitInCents: 8400, ordersWithKnownCost: 6, ordersWithUnknownCost: 3 },
    products: [CANDLE, UNTRACKED],
    performance: [{ itemId: "internal:item:p1", orderCount: 6, revenueInCents: 19200 }],
  });
  // There is exactly one profit total in the whole object, and it is the same
  // number Analytics shows. The per-product view publishes unit economics only,
  // so there is no second total to disagree with the first.
  const itemFields = Object.keys(plan.items[0]).sort();
  check(
    "per-product rows carry no profit total",
    itemFields.filter((f) => f.toLowerCase().includes("profit")),
    []
  );
  assert("the only total lives on store", typeof plan.store.profitInCents === "number");
  check("and it is getProfitSummary's own number, untouched", plan.store.profitInCents, 8400);
}

// ---------------------------------------------------------------------------
console.log("\nT7. Ratio maths, including the divide-by-zero case");
{
  check("half margin", computeItemMargin({ priceInCents: 1000, costInCents: 500 }).marginRatio, 0.5);
  check("full margin", computeItemMargin({ priceInCents: 1000, costInCents: 0 }).marginRatio, 1);
  check(
    "a free product yields null rather than Infinity",
    computeItemMargin({ priceInCents: 0, costInCents: 500 }).marginRatio,
    null
  );
  check(
    "though its real loss is still reported",
    computeItemMargin({ priceInCents: 0, costInCents: 500 }).unitMarginInCents,
    -500
  );
}

// ---------------------------------------------------------------------------
console.log("\nT8. Selling below cost is reported, not hidden");
{
  const underwater = computeItemMargin({ priceInCents: 1500, costInCents: 2200 });
  check("a real negative margin", underwater.unitMarginInCents, -700);
  assert("and a real negative ratio", (underwater.marginRatio ?? 0) < 0, `${underwater.marginRatio}`);

  const plan = planProfitability({
    profitSummary: { profitInCents: -4200, ordersWithKnownCost: 6, ordersWithUnknownCost: 0 },
    products: [{ id: "p3", name: "Loss Leader", priceInCents: 1500, costInCents: 2200 }],
    performance: [{ itemId: "internal:item:p3", orderCount: 6, revenueInCents: 9000 }],
  });
  check("a store-wide loss is passed through, not floored at zero", plan.store.profitInCents, -4200);
  check("with complete coverage still reported honestly", plan.store.coverage, "complete");
}

// ---------------------------------------------------------------------------
console.log("\nOrdering");
{
  const plan = planProfitability({
    profitSummary: { profitInCents: 100, ordersWithKnownCost: 1, ordersWithUnknownCost: 0 },
    products: [UNTRACKED, CANDLE],
    performance: [
      { itemId: "internal:item:p1", orderCount: 6, revenueInCents: 19200 },
      { itemId: "internal:item:p2", orderCount: 1, revenueInCents: 2400 },
    ],
  });
  check("best-selling first, regardless of input order", plan.items.map((i) => i.name), ["Cedar Candle", "Brass Holder"]);
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
