import "@/scripts/lib/allowServerOnly";
import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prismaSystem } from "@/lib/prisma";
import { getProfitSummary, getOrderSummary, getRevenueTrend } from "@/lib/dashboard/whatHappened";
import { ORDER_STATUSES, countsAsRevenue, REVENUE_ORDER_FILTER } from "@/lib/orders/orderStatus";

// A REFUNDED ORDER IS NOT PROFIT:
//
//   part of the database sweep — npx tsx scripts/run-db-suites.ts profit-refunds-db
//
// ============ THE INVARIANT (2026-09-14) ==============================
//
// getOrderSummary took this correction on 2026-08-20 — "REFUNDED MONEY IS NOT
// REVENUE... a refund left the dashboard still reporting the money as earned.
// The owner was being shown income they had given back." getProfitSummary,
// forty lines below it in the same file, still summed every Order row.
//
// Rendered on Analytics, a store with two paid sales of $50 (cost $20) and one
// refund of the same value showed $100.00 in revenue — correct — beside
// $90.00 profit. Impossible with a $20 cost on a $50 sale, and nearer to
// revenue than the truthful $60.00.
//
// The correction is getOrderSummary's own filter and nothing more: Order.status
// defaults to "paid" and the only other value any payment path writes is
// "refunded", so no new status vocabulary enters the system.
//
// BOTH SIDES OF THE FRACTION. getOrderSummary keeps refunded orders in its
// COUNT on purpose — one genuinely happened. These counts are a different
// thing: the denominator of "how much of your profit could be worked out". An
// order that earned nothing is not profit-with-unknown-cost; it is not profit.
//
// THE TWO SUMMARIES ARE ASSERTED TOGETHER, because the defect was only legible
// as a contradiction between them on one screen.

let failures = 0;
let passes = 0;
const failed: string[] = [];

function assert(name: string, ok: boolean, detail = ""): void {
  if (ok) passes++;
  else {
    failures++;
    failed.push(`${name}${detail ? `  — ${detail}` : ""}`);
  }
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  — ${detail}` : ""}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
  assert(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

let seq = 0;

/** A store with one $50 product costing $20, unless cost is nulled. */
async function makeStore(stamp: number, opts: { cost?: number | null } = {}) {
  const n = ++seq;
  const user = await prismaSystem.user.create({
    data: { email: `pr-${stamp}-${n}@example.test` },
  });
  const store = await prismaSystem.store.create({
    data: { userId: user.id, name: "Profit Shop", slug: `pr-${stamp}-${n}`, currency: "USD" },
  });
  const product = await prismaSystem.product.create({
    data: {
      storeId: store.id, name: "Copper Ring", description: "d",
      priceInCents: 5000, costInCents: opts.cost === undefined ? 2000 : opts.cost, active: true,
    },
  });
  return { store, product };
}

async function order(
  storeId: string,
  productId: string | null,
  status: string,
  ref: string,
) {
  await prismaSystem.order.create({
    data: {
      storeId, productId, productName: "Copper Ring", quantity: 1,
      amountInCents: 5000, buyerEmail: `buyer-${ref}@example.test`,
      paymentProvider: "STRIPE", externalOrderId: `cs_${ref}`, status,
    },
  });
}

async function main(): Promise<void> {
  await requireTestDatabase(prismaSystem);
  const stamp = Date.now();

  // ====================================================================
  console.log("\n1. All paid — the existing behaviour, unchanged\n");
  // ====================================================================
  {
    const { store, product } = await makeStore(stamp);
    await order(store.id, product.id, "paid", `a${stamp}`);
    await order(store.id, product.id, "paid", `b${stamp}`);

    const profit = await getProfitSummary(store.id);
    eq("two $50 sales at $20 cost make $60", profit.profitInCents, 6000);
    eq("both are tracked", profit.ordersWithKnownCost, 2);
    eq("and none is untracked", profit.ordersWithUnknownCost, 0);
  }

  // ====================================================================
  console.log("\n2. A refund contributes nothing to profit\n");
  // ====================================================================
  {
    const { store, product } = await makeStore(stamp);
    await order(store.id, product.id, "refunded", `c${stamp}`);

    const profit = await getProfitSummary(store.id);
    // THE ASSERTION THIS SUITE EXISTS FOR. Before the fix this was 3000 — the
    // refunded sale's $50 minus its $20 cost, counted as money kept.
    eq("a refunded sale adds no profit", profit.profitInCents, 0);
    eq("and is not counted as tracked", profit.ordersWithKnownCost, 0);
    // AND NOT SHUFFLED INTO THE OTHER BUCKET. Excluding it from the numerator
    // while leaving it in the denominator would turn "we know what you kept on
    // 0 of 1 orders" into a different lie.
    eq("nor as an order whose cost is unknown", profit.ordersWithUnknownCost, 0);
  }

  // ====================================================================
  console.log("\n3. Mixed paid and refunded — the rendered case\n");
  // ====================================================================
  {
    const { store, product } = await makeStore(stamp);
    await order(store.id, product.id, "paid", `d${stamp}`);
    await order(store.id, product.id, "paid", `e${stamp}`);
    await order(store.id, product.id, "refunded", `f${stamp}`);

    const profit = await getProfitSummary(store.id);
    const summary = await getOrderSummary(store.id, { includeRevenue: true });

    eq("profit counts only the two sales that stuck", profit.profitInCents, 6000);
    eq("tracked is two, not three", profit.ordersWithKnownCost, 2);
    eq("and nothing is parked as unknown-cost", profit.ordersWithUnknownCost, 0);

    // THE CONTRADICTION, CLOSED. Revenue has excluded refunds since
    // 2026-08-20; profit did not, so one screen showed $100 beside $90.
    eq("revenue still excludes the refund, as it always has",
      summary.allTimeRevenueInCents, 10000);
    eq("  and the order COUNT still includes it, as it always has",
      summary.allTimeOrderCount, 3);
    assert("profit can no longer exceed what a 40% cost allows",
      profit.profitInCents <= (summary.allTimeRevenueInCents ?? 0) * 0.6,
      `profit ${profit.profitInCents} vs revenue ${summary.allTimeRevenueInCents}`);
  }

  // ====================================================================
  console.log("\n4. Unknown cost is still its own answer\n");
  // ====================================================================
  {
    // A refund must not be able to disguise itself as a costing gap, and a
    // real costing gap must still be reported.
    const { store, product } = await makeStore(stamp, { cost: null });
    await order(store.id, product.id, "paid", `g${stamp}`);
    await order(store.id, product.id, "refunded", `h${stamp}`);

    const profit = await getProfitSummary(store.id);
    eq("the paid order with no cost is untracked", profit.ordersWithUnknownCost, 1);
    eq("  the refunded one is absent entirely", profit.ordersWithKnownCost, 0);
    eq("  and no profit is claimed", profit.profitInCents, 0);
  }

  // ====================================================================
  console.log("\n5. Disputed and charged-back money is not income either\n");
  // ====================================================================
  //
  // countsAsRevenue has excluded these since 2026-08-30 — "a disputed order's
  // money has been withdrawn. Counting it while it is out of the account would
  // report income the business does not have." The dashboard's own money reads
  // spelled a narrower rule, `{ status: { not: "refunded" } }`, so J4 and the
  // dashboard disagreed about revenue for exactly these two states.
  for (const status of ["disputed", "charged_back"] as const) {
    const { store, product } = await makeStore(stamp);
    await order(store.id, product.id, "paid", `p-${status}-${stamp}`);
    await order(store.id, product.id, status, `x-${status}-${stamp}`);

    const profit = await getProfitSummary(store.id);
    const summary = await getOrderSummary(store.id, { includeRevenue: true });
    const trend = await getRevenueTrend(store.id, 30);

    eq(`${status}: revenue counts only the paid sale`, summary.allTimeRevenueInCents, 5000);
    eq(`  ${status}: profit counts only the paid sale`, profit.profitInCents, 3000);
    eq(`  ${status}: and only that one is tracked`, profit.ordersWithKnownCost, 1);
    // THE SPARKLINE HAD NO STATUS FILTER AT ALL, so it drew every reversal as
    // income on the surface an owner sees first.
    eq(`  ${status}: the revenue trend totals only the paid sale`,
      trend.reduce((a, b) => a + b, 0), 5000);
    // A COUNT IS NOT MONEY. A disputed order genuinely happened.
    eq(`  ${status}: the order count still includes it`, summary.allTimeOrderCount, 2);
  }

  // ====================================================================
  console.log("\n6. The query filter and the predicate cannot drift\n");
  // ====================================================================
  {
    // countsAsRevenue cannot run inside a Prisma where clause, so the rule has
    // two shapes. Asserted across the whole vocabulary rather than the two
    // statuses that happened to be interesting today: a fifth status added to
    // one shape and forgotten in the other is exactly how this gap opened.
    assert("the vocabulary is the one this rule must cover",
      ORDER_STATUSES.length >= 4, JSON.stringify(ORDER_STATUSES));
    for (const status of ORDER_STATUSES) {
      eq(`  ${status}: filter and predicate agree`,
        status === REVENUE_ORDER_FILTER.status, countsAsRevenue(status));
    }
  }

  console.log(`\n${failures} failed, ${passes} passed`);
  if (failures > 0) {
    console.log("\nFAILED:");
    for (const line of failed) console.log(`  ${line}`);
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prismaSystem.$disconnect();
  });
