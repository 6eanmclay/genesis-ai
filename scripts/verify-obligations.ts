import { planObligations, type OrderRow } from "@/lib/businessModel/obligations";

// M6 — the acceptance suite. No database, no environment:
//
//   npx tsx scripts/verify-obligations.ts
//
// The rule every test here defends: paid-and-unfulfilled, fulfilled, refunded
// and label-purchased are four different facts. Blurring any two would have J4
// telling an owner they have neglected a customer whose parcel they posted on
// Tuesday, or telling a refunded customer they are still waiting.

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

const NOW = new Date("2026-08-18T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

function order(over: Partial<OrderRow> = {}): OrderRow {
  return {
    productName: "Cedar Candle",
    buyerEmail: "sarah@example.com",
    status: "paid",
    fulfillmentStatus: "unfulfilled",
    trackingNumber: null,
    carrier: null,
    createdAt: daysAgo(3),
    ...over,
  };
}

const breakdownFor = (orders: OrderRow[]) => ({
  fulfilledCount: orders.filter((o) => o.fulfillmentStatus === "fulfilled").length,
  unfulfilledCount: orders.filter((o) => o.fulfillmentStatus === "unfulfilled").length,
});

function plan(orders: OrderRow[]) {
  return planObligations({ orders, breakdown: breakdownFor(orders), now: NOW });
}

// ---------------------------------------------------------------------------
console.log("\nT1. Outstanding orders are identified, oldest first, with real ages");
{
  const result = plan([
    order({ productName: "Recent", createdAt: daysAgo(1) }),
    order({ productName: "Oldest", createdAt: daysAgo(21) }),
    order({ productName: "Middle", createdAt: daysAgo(6) }),
  ]);
  check("three people are waiting", result.outstandingCount, 3);
  check("oldest first", result.outstanding.map((o) => o.productName), ["Oldest", "Middle", "Recent"]);
  check("with real days waiting", result.outstanding.map((o) => o.daysWaiting), [21, 6, 1]);
  check("and the longest wait surfaced", result.oldestWaitingDays, 21);
  check("buyer identity carried so J4 can name who is waiting", result.outstanding[0].buyerEmail, "sarah@example.com");
}

// ---------------------------------------------------------------------------
console.log("\nT2. A refunded order is never an outstanding obligation");
{
  const result = plan([
    order({ productName: "Still owed" }),
    order({ productName: "Refunded", status: "refunded", createdAt: daysAgo(30) }),
  ]);
  check("only the paid one is owed", result.outstanding.map((o) => o.productName), ["Still owed"]);
  check("outstandingCount excludes it", result.outstandingCount, 1);
  check("but it is counted, not hidden", result.refundedUnfulfilledCount, 1);
  check(
    "and its 30-day age never becomes the oldest wait",
    result.oldestWaitingDays,
    3
  );
}

// ---------------------------------------------------------------------------
console.log("\nT3. Counts reconcile with the dashboard's own totals");
{
  const orders = [
    order(),
    order({ status: "refunded" }),
    order({ status: "pending" }),
    order({ fulfillmentStatus: "fulfilled" }),
  ];
  const result = plan(orders);
  check("the dashboard's unfulfilled total is carried through unchanged", result.unfulfilledCount, 3);
  check("and its fulfilled total too", result.fulfilledCount, 1);
  assert(
    "every unfulfilled order lands in exactly one bucket",
    result.outstandingCount + result.refundedUnfulfilledCount + result.otherUnfulfilledCount === result.unfulfilledCount,
    `${result.outstandingCount} + ${result.refundedUnfulfilledCount} + ${result.otherUnfulfilledCount} = ${result.unfulfilledCount}`
  );
  check("an unpaid order is not an obligation", result.outstandingCount, 1);
  check("its status is named rather than assumed", result.otherUnfulfilledStatuses, ["pending"]);
}

// ---------------------------------------------------------------------------
console.log("\nT4. No orders is honest emptiness, not 'everything shipped'");
{
  const result = plan([]);
  check("nothing outstanding", result.outstanding, []);
  check("null, not zero days", result.oldestWaitingDays, null);
  check("and no invented totals", [result.fulfilledCount, result.unfulfilledCount], [0, 0]);
}
{
  // Everything genuinely fulfilled — still no claim about physical delivery.
  const result = plan([order({ fulfillmentStatus: "fulfilled" }), order({ fulfillmentStatus: "fulfilled" })]);
  check("nobody is waiting", result.outstandingCount, 0);
  check("oldest wait is null", result.oldestWaitingDays, null);
  check("fulfilled count is real", result.fulfilledCount, 2);
}

// ---------------------------------------------------------------------------
console.log("\nT5. Label-purchased and marked-fulfilled stay distinct facts");
{
  const result = plan([
    order({ productName: "Label bought", trackingNumber: "9400111899", carrier: "USPS" }),
    order({ productName: "No label" }),
  ]);
  const labelled = result.outstanding.find((o) => o.productName === "Label bought");
  const bare = result.outstanding.find((o) => o.productName === "No label");

  assert("an order with a label is STILL outstanding", labelled !== undefined);
  check("because a label is not the owner's acknowledgment", result.outstandingCount, 2);
  check("the label is reported as a fact of its own", labelled?.labelPurchased, true);
  check("with the real carrier", labelled?.carrier, "USPS");
  check("and an order without one says so", bare?.labelPurchased, false);
  check("never inventing a carrier", bare?.carrier, null);
}

// ---------------------------------------------------------------------------
console.log("\nT6. No unnecessary personal information travels");
{
  const result = plan([order()]);
  check(
    "an outstanding order carries exactly these fields",
    Object.keys(result.outstanding[0]).sort(),
    ["buyerEmail", "carrier", "daysWaiting", "labelPurchased", "orderedAt", "productName"]
  );
  const serialized = JSON.stringify(result).toLowerCase();
  const forbidden = ["address", "street", "postal", "zip", "phone", "line1", "city"];
  check("and nothing address-shaped appears anywhere", forbidden.filter((w) => serialized.includes(w)), []);
}

// ---------------------------------------------------------------------------
console.log("\nT7. Age is computed from the order date, deterministically");
{
  const result = plan([
    order({ productName: "Today", createdAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000) }),
    order({ productName: "Yesterday", createdAt: daysAgo(1) }),
  ]);
  check("a few hours old is zero days, not one", result.outstanding.find((o) => o.productName === "Today")?.daysWaiting, 0);
  check("a day old is one", result.outstanding.find((o) => o.productName === "Yesterday")?.daysWaiting, 1);
  // A clock skew must never produce a negative wait.
  const future = plan([order({ createdAt: new Date(NOW.getTime() + 60 * 60 * 1000) })]);
  check("a future-dated order never reports negative days", future.outstanding[0].daysWaiting, 0);
}

// ---------------------------------------------------------------------------
console.log("\nT8. No late/overdue threshold is encoded anywhere");
{
  const result = plan([order({ createdAt: daysAgo(45) }), order({ createdAt: daysAgo(1) })]);
  const serialized = JSON.stringify(result).toLowerCase();
  const judgments = ["late", "overdue", "urgent", "delayed", "breach", "warning"];
  check("no judgment words in the data", judgments.filter((w) => serialized.includes(w)), []);
  // A 45-day wait and a 1-day wait are reported identically in kind — only the
  // number differs. J4 judges; the data does not.
  check("both are plain numbers", result.outstanding.map((o) => o.daysWaiting), [45, 1]);
  assert(
    "and no field claims a status beyond the facts",
    Object.keys(result).every((k) => !judgments.some((w) => k.toLowerCase().includes(w)))
  );
}

// ---------------------------------------------------------------------------
console.log("\nT9. Fulfilled orders never appear as owed");
{
  const result = plan([
    order({ productName: "Done", fulfillmentStatus: "fulfilled", createdAt: daysAgo(60) }),
    order({ productName: "Owed" }),
  ]);
  check("only the unfulfilled one is listed", result.outstanding.map((o) => o.productName), ["Owed"]);
  check("and a long-since-fulfilled order never sets the oldest wait", result.oldestWaitingDays, 3);
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
