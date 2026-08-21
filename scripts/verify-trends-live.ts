import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";

// CHAPTER 1, TIER 2 — TEMPORAL UNDERSTANDING:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-trends-live.ts" -OutFile out.txt
//
// ARCHITECTURE.md's frozen 4-tier roadmap calls Tier 2 "one capability, two
// presentations": trend looks backward and forecast looks forward, and both
// reduce to the same rate-of-change computation. computeTrend, getRevenueTrend,
// getItemPerformanceTrend, projectForward and predictGoalTrajectory are that
// tier, and none had coverage.
//
// EVERY ONE OF THEM CAN REFUSE, and the refusals are the point:
//
//   computeTrend          a zero baseline is no trend, not a 100% rise. You
//                         cannot say revenue "doubled" from nothing.
//   predictGoalTrajectory not a revenue goal, no target date, no target number,
//                         or a backwards window — all null, never a projection
//                         built on a missing input.
//   getRevenue            refunds subtract, so a trend is over money kept.
//
// Nothing here is AI and nothing is externally blocked: these are deterministic
// computations over real Order rows, which map into transactions automatically.

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

  const { computeTrend, projectForward, getRevenueTrend, getItemPerformanceTrend, predictGoalTrajectory, getRevenue } =
    await import("@/lib/businessModel/reasoning");
  const { prismaSystem: prisma } = await import("@/lib/prisma");

  let n = 0;
  const makeStore = (userId: string, name: string) =>
    prisma.store.create({
      data: {
        userId, name, slug: `${name.toLowerCase().replace(/[^a-z]+/g, "-")}-${++n}`,
        tagline: "t", description: "d", currency: "USD",
      },
    });

  // ==========================================================================
  console.log("\n=== 1. A trend needs a baseline ===\n");
  // ==========================================================================
  // THE REFUSAL THAT MATTERS MOST. Growing from nothing is not a percentage.
  check("no previous value is no trend", computeTrend(500, 0), null);
  assert("even when the current value is large", computeTrend(1_000_000, 0) === null);

  const up = computeTrend(150, 100);
  check("a real rise is up", up?.direction, "up");
  check("with the real change", up?.change, 50);
  check("and the real ratio", up?.changeRatio, 0.5);

  check("a real fall is down", computeTrend(50, 100)?.direction, "down");
  // Under 1% reads as flat rather than as a movement worth mentioning.
  check("a half-percent move is flat, not noise reported as news", computeTrend(1_004, 1_000)?.direction, "flat");
  check("and so is a half-percent drop", computeTrend(996, 1_000)?.direction, "flat");
  check("but 2% is a real move", computeTrend(1_020, 1_000)?.direction, "up");
  check("exactly no change is flat", computeTrend(1_000, 1_000)?.direction, "flat");
  // A negative current value against a positive baseline still reads honestly.
  check("a collapse past zero is still down", computeTrend(-50, 100)?.direction, "down");

  // ==========================================================================
  console.log("\n=== 2. Projecting forward is arithmetic, not optimism ===\n");
  // ==========================================================================
  check("half way through, double what is banked", projectForward(500, 5 * DAY, 10 * DAY), 1_000);
  check("a full window projects to itself", projectForward(500, 10 * DAY, 10 * DAY), 500);
  // No elapsed time is no rate. Dividing by it would be an infinite projection.
  check("no time elapsed projects exactly what exists", projectForward(500, 0, 10 * DAY), 500);
  check("and negative elapsed time does the same", projectForward(500, -1, 10 * DAY), 500);
  check("nothing banked projects to nothing", projectForward(0, 5 * DAY, 10 * DAY), 0);

  // ==========================================================================
  console.log("\n=== 3. Revenue trend over real orders ===\n");
  // ==========================================================================
  const owner = await prisma.user.create({ data: { email: "trends@example.test" } });
  const iron = await makeStore(owner.id, "Iron Gym");
  const copper = await makeStore(owner.id, "Copper and Coil");

  let ext = 0;
  const order = (storeId: string, amountInCents: number, day: number, status = "paid") =>
    prisma.order.create({
      data: {
        storeId, productName: "x", buyerEmail: "b@example.test",
        amountInCents, status, paymentProvider: "STRIPE",
        externalOrderId: `t-${++ext}`, createdAt: daysAgo(day),
      },
    });

  // Previous week: 100. This week: 150. A real 50% rise.
  await order(iron.id, 10_000, 10);
  await order(iron.id, 15_000, 3);

  const trend = await getRevenueTrend(iron.id, { windowDays: 7 });
  check("the current window is this week's revenue", trend?.currentValue, 15_000);
  check("the previous window is last week's", trend?.previousValue, 10_000);
  check("which is a rise", trend?.direction, "up");
  check("of half again", trend?.changeRatio, 0.5);

  // A refund subtracts, so the trend is over money KEPT rather than money taken.
  await order(iron.id, 5_000, 2, "refunded");
  const afterRefund = await getRevenueTrend(iron.id, { windowDays: 7 });
  check("a refund reduces this week's revenue", afterRefund?.currentValue, 10_000);
  check("so the rise becomes flat", afterRefund?.direction, "flat");

  // No prior week at all — no baseline, no trend. Not "infinite growth".
  const fresh = await makeStore(owner.id, "Fresh Business");
  await order(fresh.id, 20_000, 1);
  check("a first week of trading has nothing to compare against", await getRevenueTrend(fresh.id, { windowDays: 7 }), null);
  check("though the revenue itself is real", await getRevenue(fresh.id), 20_000);

  // ==========================================================================
  console.log("\n=== 4. Per-item trends, including items that are new ===\n");
  // ==========================================================================
  const bench = await prisma.product.create({
    data: { storeId: iron.id, name: "Bench", description: "d", priceInCents: 5_000, active: true },
  });
  const rower = await prisma.product.create({
    data: { storeId: iron.id, name: "Rower", description: "d", priceInCents: 9_000, active: true },
  });

  const itemOrder = (productId: string, amountInCents: number, day: number) =>
    prisma.order.create({
      data: {
        storeId: iron.id, productId, productName: "x", buyerEmail: "b@example.test",
        amountInCents, status: "paid", paymentProvider: "STRIPE",
        externalOrderId: `i-${++ext}`, createdAt: daysAgo(day),
      },
    });

  await itemOrder(bench.id, 4_000, 10);
  await itemOrder(bench.id, 8_000, 3);
  // Sold this week only — no prior figure to compare against.
  await itemOrder(rower.id, 9_000, 2);

  const itemTrends = await getItemPerformanceTrend(iron.id, { windowDays: 7 });
  const benchTrend = itemTrends.find((t) => t.item.data.name === "Bench");
  const rowerTrend = itemTrends.find((t) => t.item.data.name === "Rower");

  check("an item with both windows has a trend", benchTrend?.trend?.direction, "up");
  check("computed from its own revenue", benchTrend?.trend?.previousValue, 4_000);
  // The same refusal, per item: a brand-new seller has no trend, not a 100% one.
  check("an item that only sold this week has no trend", rowerTrend?.trend, null);
  assert("rather than being reported as infinite growth", rowerTrend !== undefined,
    "the item is still listed — it is the TREND that is null, not the item");

  // ==========================================================================
  console.log("\n=== 5. A goal trajectory refuses more often than it answers ===\n");
  // ==========================================================================
  const goal = (data: Record<string, unknown>) => ({
    id: "goal-1",
    entityType: "goal" as const,
    sourceProvider: "internal",
    syncedAt: new Date(),
    data: {
      description: "Reach the target",
      category: "revenue",
      status: "active",
      priority: "high",
      identifiedAt: daysAgo(10).toISOString(),
      targetDate: daysAgo(-10).toISOString(),
      targetValueInCents: 100_000,
      relatedChallengeIds: [],
      ...data,
    },
  });

  check("a goal that is not about revenue has no trajectory",
    await predictGoalTrajectory(iron.id, goal({ category: "hiring" }) as never), null);
  check("a goal with no target date has none",
    await predictGoalTrajectory(iron.id, goal({ targetDate: null }) as never), null);
  check("a goal with no target number has none",
    await predictGoalTrajectory(iron.id, goal({ targetValueInCents: null }) as never), null);
  // A target date before the goal was even identified is not a window.
  check("a backwards window has none",
    await predictGoalTrajectory(iron.id, goal({ targetDate: daysAgo(20).toISOString() }) as never), null);

  // A real one: 10 days in, 10 to go, so half the window has elapsed.
  const real = await predictGoalTrajectory(iron.id, goal({}) as never);
  assert("a complete revenue goal does produce one", real !== null);
  check("the target is carried through unchanged", real?.targetValueInCents, 100_000);
  check("half way through, half the target is expected", real?.expectedByNowInCents, 50_000);
  assert("what was actually earned is real revenue, not an estimate",
    real?.actualSoFarInCents === (await getRevenue(iron.id, { since: daysAgo(10), until: new Date() })));
  assert("and being behind is reported as behind",
    real?.onTrack === (real!.actualSoFarInCents >= real!.expectedByNowInCents));

  // A deadline in the past is named rather than silently projected past.
  const passed = await predictGoalTrajectory(
    iron.id,
    goal({ identifiedAt: daysAgo(30).toISOString(), targetDate: daysAgo(5).toISOString() }) as never
  );
  check("a passed deadline says so", passed?.deadlinePassed, true);

  // ==========================================================================
  console.log("\n=== 6. Trends do not cross businesses ===\n");
  // ==========================================================================
  check("a business with no orders has no revenue trend", await getRevenueTrend(copper.id, { windowDays: 7 }), null);
  check("and no revenue", await getRevenue(copper.id), 0);
  check("and no item trends", await getItemPerformanceTrend(copper.id, { windowDays: 7 }), []);

  await order(copper.id, 1_000, 10);
  await order(copper.id, 500, 3);
  const copperTrend = await getRevenueTrend(copper.id, { windowDays: 7 });
  check("its own trend is its own", copperTrend?.currentValue, 500);
  check("and points the other way from the neighbour's", copperTrend?.direction, "down");

  const [ironAgain, copperAgain] = await Promise.all([
    getRevenueTrend(iron.id, { windowDays: 7 }),
    getRevenueTrend(copper.id, { windowDays: 7 }),
  ]);
  assert("concurrent reads stay separate",
    ironAgain?.currentValue !== copperAgain?.currentValue,
    "one rising, one falling, read at the same moment");

  await prisma.$disconnect();
  await db.close();

  console.log(`\n${failures === 0 ? "All trend assertions passed." : `${failures} assertion(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
