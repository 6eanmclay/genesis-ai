import {
  planNetOfPostage,
  planProfitability,
  summarizeMarginCoverage,
  PROFIT_BASIS,
  type OrderCostRow,
} from "@/lib/businessModel/profitability";

// M7 — the acceptance suite. No database, no environment:
//
//   npx tsx scripts/verify-net-of-postage.ts
//
// The rule: postage counts only where a real label purchase recorded it. A
// missing postage cost is never free shipping, and never borrowed from another
// order — not even another order of the same product.

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

// The scenario from the proposal: a $32 candle, $18 of materials, a $12 label.
const SHIPPED: OrderCostRow = {
  productId: "p1",
  amountInCents: 3200,
  productCostInCents: 1800,
  shippingCostInCents: 1200,
};
const NO_LABEL: OrderCostRow = { ...SHIPPED, shippingCostInCents: null };
const NO_COST: OrderCostRow = { ...SHIPPED, productCostInCents: null };

// ---------------------------------------------------------------------------
console.log("\nT1. Recorded postage is included in what the owner actually kept");
{
  const net = planNetOfPostage([SHIPPED]);
  check("kept $2, not $14", net.profitAfterRecordedCostsInCents, 200);
  check("real postage reported", net.postageSpentInCents, 1200);
  check("one order fully costed", net.ordersFullyCosted, 1);
  check("coverage complete", net.coverage, "complete");
}

// ---------------------------------------------------------------------------
console.log("\nT2. An order with no recorded postage is excluded, not assumed free");
{
  const net = planNetOfPostage([SHIPPED, NO_LABEL]);
  check("only the shipped order contributes", net.profitAfterRecordedCostsInCents, 200);
  check("the other is counted, not silently dropped", net.ordersWithCostButNoPostage, 1);
  check("coverage says partial", net.coverage, "partial");
  // If postage had been assumed free, net would have been 200 + 1400 = 1600.
  assert("free shipping was never assumed", net.profitAfterRecordedCostsInCents !== 1600);
}

// ---------------------------------------------------------------------------
console.log("\nT3. No label purchased anywhere is an honest unknown");
{
  const net = planNetOfPostage([NO_LABEL, NO_LABEL]);
  check("net is null, never 0", net.profitAfterRecordedCostsInCents, null);
  check("postage is null, never 0", net.postageSpentInCents, null);
  check("coverage none", net.coverage, "none");
  check("but the orders are counted", net.ordersWithCostButNoPostage, 2);
}
{
  const net = planNetOfPostage([]);
  check("no orders at all is also null", net.profitAfterRecordedCostsInCents, null);
  check("with no invented postage", net.postageSpentInCents, null);
}

// ---------------------------------------------------------------------------
console.log("\nT4. Postage is never borrowed from another order");
{
  // Two orders of the SAME product. One has a real label, one does not. The
  // most tempting wrong answer is to apply $12 to both.
  const net = planNetOfPostage([SHIPPED, { ...NO_LABEL, productId: "p1" }]);
  check("the unlabelled order stays out", net.ordersFullyCosted, 1);
  check("net covers one order only", net.profitAfterRecordedCostsInCents, 200);
  check("and postage is the one real charge", net.postageSpentInCents, 1200);

  // Same at the per-product level.
  const plan = planProfitability({
    profitSummary: { profitInCents: 2800, ordersWithKnownCost: 2, ordersWithUnknownCost: 0 },
    products: [{ id: "p1", name: "Cedar Candle", priceInCents: 3200, costInCents: 1800 }],
    performance: [{ itemId: "internal:item:p1", orderCount: 2, revenueInCents: 6400 }],
    orders: [SHIPPED, { ...NO_LABEL, productId: "p1" }],
  });
  check("per product, one order is fully costed", plan.items[0].ordersFullyCosted, 1);
  check("per-product kept is the real one", plan.items[0].keptAfterRecordedCostsInCents, 200);
  check("per-product postage is the real charge", plan.items[0].postageSpentInCents, 1200);
}

// ---------------------------------------------------------------------------
console.log("\nT5. An order that lost money after postage says so");
{
  // $20 sale, $14 materials, $9 postage — a real $3 loss.
  const net = planNetOfPostage([
    { productId: "p2", amountInCents: 2000, productCostInCents: 1400, shippingCostInCents: 900 },
  ]);
  check("a real negative net", net.profitAfterRecordedCostsInCents, -300);
  check("not floored at zero", net.coverage, "complete");
}

// ---------------------------------------------------------------------------
console.log("\nT6. Net is exactly M5's figure minus real postage");
{
  // The invariant that makes the two numbers explainable to an owner: with
  // complete coverage, exactly one variable separates them.
  const orders: OrderCostRow[] = [
    SHIPPED,
    { productId: "p2", amountInCents: 5000, productCostInCents: 2000, shippingCostInCents: 800 },
  ];
  const m5Profit = orders.reduce((sum, o) => sum + o.amountInCents - (o.productCostInCents ?? 0), 0);
  const net = planNetOfPostage(orders);
  check("M5's basis", m5Profit, 4400);
  check("M7's net", net.profitAfterRecordedCostsInCents, 2400);
  assert(
    "net === M5 profit − postage",
    net.profitAfterRecordedCostsInCents === m5Profit - (net.postageSpentInCents ?? 0),
    `${net.profitAfterRecordedCostsInCents} === ${m5Profit} − ${net.postageSpentInCents}`
  );
}

// ---------------------------------------------------------------------------
console.log("\nT7. M5's own figure is unchanged by the extension");
{
  const m5Inputs = {
    profitSummary: { profitInCents: 8400, ordersWithKnownCost: 6, ordersWithUnknownCost: 3 },
    products: [{ id: "p1", name: "Cedar Candle", priceInCents: 3200, costInCents: 1800 }],
    performance: [{ itemId: "internal:item:p1", orderCount: 6, revenueInCents: 19200 }],
  };
  const withoutOrders = planProfitability(m5Inputs);
  const withOrders = planProfitability({ ...m5Inputs, orders: [SHIPPED] });

  check("store figure identical with orders present", withOrders.store, withoutOrders.store);
  check("and it is still getProfitSummary's own number", withOrders.store.profitInCents, 8400);
  check("unit economics identical", withOrders.items[0].unitMarginInCents, withoutOrders.items[0].unitMarginInCents);
  // Called the old way, M7's block is honestly empty rather than absent.
  check("no orders means no postage claim", withoutOrders.netOfPostage.profitAfterRecordedCostsInCents, null);
  check("and no invented postage", withoutOrders.netOfPostage.postageSpentInCents, null);
}

// ---------------------------------------------------------------------------
console.log("\nT8. Orders with no product cost are counted out separately");
{
  const net = planNetOfPostage([SHIPPED, NO_COST]);
  check("only the fully costed order contributes", net.profitAfterRecordedCostsInCents, 200);
  check("the cost-less order is counted", net.ordersWithoutProductCost, 1);
  check("coverage partial", net.coverage, "partial");
  // Its postage was still really paid, so it is still really reported.
  check("its real postage is still counted as money spent", net.postageSpentInCents, 2400);
}

// ---------------------------------------------------------------------------
console.log("\nT9. Payment-processing fees are excluded, and said to be excluded");
{
  const plan = planProfitability({
    profitSummary: { profitInCents: 1400, ordersWithKnownCost: 1, ordersWithUnknownCost: 0 },
    products: [{ id: "p1", name: "Cedar Candle", priceInCents: 3200, costInCents: 1800 }],
    performance: [],
    orders: [SHIPPED],
  });

  // Checked on FIELD NAMES, not serialized text: the basis string deliberately
  // says "payment-processing fees" out loud, and that sentence is the point
  // rather than a leak. What must not exist is a field claiming to hold one.
  const allKeys = [
    ...Object.keys(plan.netOfPostage),
    ...Object.keys(plan.store),
    ...Object.keys(plan.items[0] ?? {}),
  ];
  check("no field claims to hold a fee", allKeys.filter((k) => /fee|processing/i.test(k)), []);
  // A fee assumption would have moved this number off the real $2.
  check("the figure is untouched by any fee assumption", plan.netOfPostage.profitAfterRecordedCostsInCents, 200);
  assert("and the exclusion is stated in the data itself", plan.netOfPostage.basis.includes("excludes payment-processing fees"));
}

// ---------------------------------------------------------------------------
console.log("\nT10. getProfitSummary's own result is passed through untouched");
{
  // The silent way M7 could break M5 is by mutating the summary it was handed.
  // Frozen input: any write throws.
  const summary = Object.freeze({ profitInCents: 8400, ordersWithKnownCost: 6, ordersWithUnknownCost: 3 });
  const plan = planProfitability({
    profitSummary: summary,
    products: [{ id: "p1", name: "Cedar Candle", priceInCents: 3200, costInCents: 1800 }],
    performance: [],
    orders: [SHIPPED, NO_LABEL, NO_COST],
  });

  check("the caller's summary is not mutated", summary, {
    profitInCents: 8400,
    ordersWithKnownCost: 6,
    ordersWithUnknownCost: 3,
  });
  // The store block must equal M5's own pure function on the same input,
  // derived here independently with no M7 input involved.
  check("store equals M5's own computation, independently derived", plan.store, summarizeMarginCoverage(summary));
  check("postage never leaks into M5's figure", plan.store.profitInCents, 8400);
  check("nor into its coverage", plan.store.coverage, "partial");
}

// ---------------------------------------------------------------------------
console.log("\nT11. The figure is described by its basis, never as complete net profit");
{
  const net = planNetOfPostage([SHIPPED]);
  check("the field is named for what it covers", "profitAfterRecordedCostsInCents" in net, true);
  check("and the object carries its own basis", net.basis, PROFIT_BASIS);
  assert("naming recorded product costs", net.basis.includes("recorded product costs"));
  assert("and recorded postage", net.basis.includes("recorded postage"));
  assert("and excluding fees out loud", net.basis.includes("excludes payment-processing fees"));
  check(
    "no key calls itself net profit or net income",
    Object.keys(net).filter((k) => /^net(Profit|Income)/i.test(k)),
    []
  );
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
