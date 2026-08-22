import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";

// POST-EXECUTION MEASUREMENT — what happened after, never why:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-measurement-live.ts" -OutFile out.txt
//
// This is the layer underneath the track record verified in
// verify-next-best-action-live.ts: positiveOutcomeRate is only meaningful if the
// measurements feeding it are real. It had no coverage.
//
// THE DISCIPLINE THIS FILE IS BUILT AROUND, in its own words: it is
// "deliberately NOT an impact/attribution calculation. concurrentActionTypes
// exists only to flag how confounded a given window is, never to weight or net
// out anyone's contribution."
//
// That is the difference between a measurement and a claim. A store that changed
// its hero, its SEO and three product photos in the same fortnight cannot have
// its extra orders assigned to one of them, and this refuses to try — it counts
// what happened, and says plainly how many other changes were happening at the
// same time. Asserting that refusal is most of the point of this suite.
//
// It is also deterministic and zero-cost: a plain before/after Order aggregate,
// no AI anywhere, so nothing here is externally blocked.

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

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

async function main() {
  const db = await startRealPostgres();
  await db.prisma.$disconnect();

  process.env[TEST_DATABASE_ENV] = "1";
  process.env.DATABASE_URL = db.url;

  const { measureDueMeasurements } = await import("@/lib/dashboard/postExecutionMeasurement");
  const { prismaSystem: prisma } = await import("@/lib/prisma");

  let n = 0;
  const makeStore = (userId: string, name: string) =>
    prisma.store.create({
      data: {
        userId, name, slug: `${name.toLowerCase().replace(/[^a-z]+/g, "-")}-${++n}`,
        tagline: "t", description: "d", currency: "USD",
      },
    });

  const owner = await prisma.user.create({ data: { email: "measure@example.test" } });

  let seq = 0;
  const executed = (storeId: string, actionType: string, decidedDaysAgo: number, input: object = {}) =>
    prisma.approvalRequest.create({
      data: {
        storeId, actionType, input, previousValues: {},
        summary: `change ${++seq}`, status: "EXECUTED",
        decidedAt: daysAgo(decidedDaysAgo),
      },
    });

  let ext = 0;
  const order = (storeId: string, amountInCents: number, daysAgoValue: number, productId?: string) =>
    prisma.order.create({
      data: {
        storeId, productId: productId ?? null, productName: "x", buyerEmail: "b@example.test",
        amountInCents, status: "paid", paymentProvider: "STRIPE",
        externalOrderId: `m-${++ext}`, createdAt: daysAgo(daysAgoValue),
      },
    });

  // ==========================================================================
  console.log("\n=== 1. Only changes old enough to have an 'after' are measured ===\n");
  // ==========================================================================
  const store = await makeStore(owner.id, "Measured Store");

  // Decided 30 days ago: its 14-day after-window is fully in the past.
  const ripe = await executed(store.id, "update_hero", 30);
  // Decided 3 days ago: the window has not closed, so measuring now would
  // compare a full fortnight before against three days after.
  const tooRecent = await executed(store.id, "update_seo", 3);
  // Never decided — a pending proposal has no "after" at all.
  await prisma.approvalRequest.create({
    data: {
      storeId: store.id, actionType: "update_theme", input: {}, previousValues: {},
      summary: "still open", status: "PENDING_APPROVAL",
    },
  });

  await measureDueMeasurements(store.id);

  const measured = await prisma.postExecutionMeasurement.findMany({ where: { storeId: store.id } });
  check("exactly one measurement", measured.length, 1);
  check("of the change whose window has closed", measured[0].approvalRequestId, ripe.id);
  assert("not the one still inside its window", measured[0].approvalRequestId !== tooRecent.id,
    "measuring early would compare a fortnight before against three days after");

  // ==========================================================================
  console.log("\n=== 2. Before and after are counted, not judged ===\n");
  // ==========================================================================
  const counted = await makeStore(owner.id, "Counted Store");
  const change = await executed(counted.id, "update_hero", 30);

  // Two orders in the fortnight BEFORE the change (days 31-44 ago).
  await order(counted.id, 5_000, 35);
  await order(counted.id, 7_000, 40);
  // Three in the fortnight AFTER (days 16-30 ago).
  await order(counted.id, 9_000, 20);
  await order(counted.id, 4_000, 25);
  await order(counted.id, 6_000, 28);
  // Well outside both windows — must be counted in neither.
  await order(counted.id, 999_999, 2);
  await order(counted.id, 888_888, 90);

  await measureDueMeasurements(counted.id);
  const m = await prisma.postExecutionMeasurement.findFirstOrThrow({
    where: { approvalRequestId: change.id },
  });

  check("the before window is counted", m.orderCountBefore, 2);
  check("and its revenue summed", m.revenueBeforeCents, 12_000);
  check("the after window is counted", m.orderCountAfter, 3);
  check("and its revenue summed", m.revenueAfterCents, 19_000);
  assert("orders outside both windows are in neither",
    m.revenueBeforeCents !== 999_999 && m.revenueAfterCents !== 999_999,
    "a 999,999 order sits just outside and would be unmissable");
  check("the window length is recorded with the numbers", m.windowDays, 14);

  // THE REFUSAL. The summary reports what happened; it never says the change
  // caused it.
  assert("the summary states the counts", m.summary.includes("3 order") && m.summary.includes("2 in the"));
  assert("and never claims causation",
    !/because|caused|thanks to|due to this|resulted in/i.test(m.summary), m.summary);

  // ==========================================================================
  console.log("\n=== 3. A confounded window says so ===\n");
  // ==========================================================================
  const busy = await makeStore(owner.id, "Busy Store");
  const subject = await executed(busy.id, "update_hero", 30);
  // Two other changes inside the same window. This is exactly the case where
  // attributing the difference to any one of them would be a fabrication.
  await executed(busy.id, "update_seo", 28);
  await executed(busy.id, "update_theme", 22);
  await order(busy.id, 1_000, 20);

  await measureDueMeasurements(busy.id);
  const confounded = await prisma.postExecutionMeasurement.findFirstOrThrow({
    where: { approvalRequestId: subject.id },
  });

  assert("the summary names how many other changes overlapped",
    confounded.summary.includes("2 other Genesis-executed change"), confounded.summary);
  assert("and says the change alone may not explain it",
    confounded.summary.includes("may not explain the difference"), confounded.summary);
  assert("naming them rather than netting them out",
    confounded.summary.includes("update_seo") && confounded.summary.includes("update_theme"),
    "flagging confoundedness, never weighting contributions");

  // A clean window carries no such caveat, so the caveat means something.
  const cleanMeasurement = await prisma.postExecutionMeasurement.findFirstOrThrow({
    where: { approvalRequestId: change.id },
  });
  assert("a clean window carries no caveat",
    !cleanMeasurement.summary.includes("may not explain"),
    "otherwise the warning would be noise on every measurement");

  // ==========================================================================
  console.log("\n=== 4. A product-scoped change measures that product only ===\n");
  // ==========================================================================
  const scoped = await makeStore(owner.id, "Scoped Store");
  const watched = await prisma.product.create({
    data: { storeId: scoped.id, name: "Watched", description: "d", priceInCents: 1_000, active: true },
  });
  const ignored = await prisma.product.create({
    data: { storeId: scoped.id, name: "Ignored", description: "d", priceInCents: 1_000, active: true },
  });

  const imageChange = await executed(scoped.id, "update_product_image", 30, { productId: watched.id });
  await order(scoped.id, 1_000, 20, watched.id);
  await order(scoped.id, 2_000, 22, watched.id);
  // The other product sold plenty in the same window and must not be counted.
  await order(scoped.id, 50_000, 21, ignored.id);
  await order(scoped.id, 50_000, 23, ignored.id);

  await measureDueMeasurements(scoped.id);
  const productMeasurement = await prisma.postExecutionMeasurement.findFirstOrThrow({
    where: { approvalRequestId: imageChange.id },
  });
  check("the scope is the product", productMeasurement.scope, "product");
  check("and it names which", productMeasurement.productId, watched.id);
  check("only that product's orders are counted", productMeasurement.orderCountAfter, 2);
  check("and only its revenue", productMeasurement.revenueAfterCents, 3_000);
  assert("the other product's 100,000 is excluded",
    (productMeasurement.revenueAfterCents ?? 0) < 50_000);

  // A store-wide change is scoped store-wide.
  check("a store-wide change is scoped to the store", cleanMeasurement.scope, "store");
  check("with no product named", cleanMeasurement.productId, null);

  // ==========================================================================
  console.log("\n=== 5. Measuring twice does not measure twice ===\n");
  // ==========================================================================
  await measureDueMeasurements(counted.id);
  check("a second sweep adds nothing",
    await prisma.postExecutionMeasurement.count({ where: { storeId: counted.id } }), 1);
  const again = await prisma.postExecutionMeasurement.findFirstOrThrow({
    where: { approvalRequestId: change.id },
  });
  check("and the original numbers are untouched", again.orderCountAfter, 3);

  // ==========================================================================
  console.log("\n=== 6. One business is never measured against another ===\n");
  // ==========================================================================
  const neighbour = await makeStore(owner.id, "Neighbour Store");
  const neighbourChange = await executed(neighbour.id, "update_hero", 30);
  // Captured before, because the busy store legitimately has three due changes
  // of its own — the point is that measuring the neighbour does not touch them.
  const busyBefore = await prisma.postExecutionMeasurement.count({ where: { storeId: busy.id } });
  // The neighbour sold nothing. The busy store next door sold plenty.
  await measureDueMeasurements(neighbour.id);
  const neighbourMeasurement = await prisma.postExecutionMeasurement.findFirstOrThrow({
    where: { approvalRequestId: neighbourChange.id },
  });
  check("a business with no orders measures zero", neighbourMeasurement.orderCountAfter, 0);
  check("and zero before", neighbourMeasurement.orderCountBefore, 0);
  assert("never the neighbour's numbers",
    (neighbourMeasurement.revenueAfterCents ?? 0) === 0,
    "an empty window is zero orders, honestly");
  assert("and no other business's change is named as concurrent",
    !neighbourMeasurement.summary.includes("update_seo"),
    neighbourMeasurement.summary);

  check("measuring one store creates nothing for another",
    await prisma.postExecutionMeasurement.count({ where: { storeId: busy.id } }), busyBefore);
  check("and the neighbour has exactly its own one",
    await prisma.postExecutionMeasurement.count({ where: { storeId: neighbour.id } }), 1);

  await prisma.$disconnect();
  await db.close();

  console.log(`\n${failures === 0 ? "All measurement assertions passed." : `${failures} assertion(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
