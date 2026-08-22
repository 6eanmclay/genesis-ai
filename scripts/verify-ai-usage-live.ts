import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";

// AI COST REPORTING — the numbers the operator actually decides on:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-ai-usage-live.ts" -OutFile out.txt
//
// These queries answer "what is this costing, and against what". They are
// platform-wide by design — cost is an operator question, not a merchant one —
// and they had no coverage.
//
// EVERY ONE OF THEM DIVIDES, which is the whole risk. An average with no
// denominator, a percentage with no revenue: each is a place where a plausible
// number can be produced from nothing. The design already distinguishes the two
// honest answers, and this pins which is which:
//
//   the averages return 0 with a count of 0 — an average of nothing is nothing
//                       spent, which is true and is what the operator wants to
//                       see on a quiet day
//   revenueVsAiCost     returns NULL for the ratio when there is no revenue to
//                       divide by, because "AI cost as a percentage of zero
//                       revenue" is not 0% or 100%, it is not a number
//
// Also asserted: these are DECIMAL costs summed as money. A cost stored as
// Decimal and read back as a float that has drifted is a reporting error nobody
// would notice until it was large.

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

  const {
    totalCostToday,
    totalCostThisMonth,
    costByFeature,
    averageCostPerVisitor,
    averageCostPerCustomer,
    averageCostPerCreatedBusiness,
    revenueVsAiCost,
  } = await import("@/lib/admin/aiUsageQueries");
  const { prismaSystem: prisma } = await import("@/lib/prisma");

  const since = daysAgo(30);

  // ==========================================================================
  console.log("\n=== 1. A quiet platform reports nothing, not nonsense ===\n");
  // ==========================================================================
  check("nothing spent today", await totalCostToday(), 0);
  check("nothing spent this month", await totalCostThisMonth(), 0);
  check("no feature has a cost", await costByFeature(since), []);

  const noVisitors = await averageCostPerVisitor(since);
  check("no visitors", noVisitors.visitorCount, 0);
  check("and their average cost is zero, not a division by zero", noVisitors.avgCostUsd, 0);
  assert("which is a real number rather than NaN", Number.isFinite(noVisitors.avgCostUsd));

  const noCustomers = await averageCostPerCustomer(since);
  check("no customers either", [noCustomers.customerCount, noCustomers.avgCostUsd], [0, 0]);
  const noBusinesses = await averageCostPerCreatedBusiness(since);
  check("and no businesses created", [noBusinesses.businessCount, noBusinesses.avgCostUsd], [0, 0]);

  // THE ONE THAT MUST BE NULL. A percentage of zero revenue is not 0% — it is
  // not a number, and reporting 0% would read as "AI costs us nothing relative
  // to what we earn", which is the opposite of what no revenue means.
  const noRevenue = await revenueVsAiCost(since);
  check("with no revenue, the ratio is null rather than a percentage", noRevenue.aiCostAsPercentOfRevenue, null);
  check("and so is the margin", noRevenue.grossAiMarginUsd, null);
  check("while the raw totals are honest zeros", [noRevenue.totalRevenueUsd, noRevenue.totalCostUsd], [0, 0]);

  // ==========================================================================
  console.log("\n=== 2. Real spend, summed as money ===\n");
  // ==========================================================================
  const owner = await prisma.user.create({ data: { email: "usage@example.test" } });
  const store = await prisma.store.create({
    data: {
      userId: owner.id, name: "Usage Store", slug: "usage-store",
      tagline: "t", description: "d", currency: "USD",
    },
  });

  const usage = (over: Record<string, unknown>) =>
    prisma.aiUsageEvent.create({
      data: {
        inputTokens: 100, outputTokens: 200, occurredAt: daysAgo(1),
        ...over,
      } as never,
    });

  // Costs chosen so a float-rounding error would show: 0.10 + 0.20 is famously
  // not 0.30 in binary floating point.
  await usage({ storeId: store.id, feature: "chat", costUsd: "0.10" });
  await usage({ storeId: store.id, feature: "chat", costUsd: "0.20" });
  await usage({ storeId: store.id, feature: "campaign_planning", costUsd: "1.50" });

  // Everything above happened YESTERDAY, so today is genuinely still zero —
  // which is the day window doing its job rather than a missing sum.
  check("yesterday's spend is not today's", await totalCostToday(), 0);
  const month = await totalCostThisMonth();
  check("but the month has it all", Number(month.toFixed(2)), 1.8);
  assert("summed without drifting", Math.abs(month - 1.8) < 0.0001, String(month));

  await usage({ storeId: store.id, feature: "chat", costUsd: "0.05", occurredAt: new Date() });
  assert("and something spent today does count",
    Math.abs((await totalCostToday()) - 0.05) < 0.0001, String(await totalCostToday()));

  const byFeature = await costByFeature(since);
  const chat = byFeature.find((f) => f.feature === "chat");
  // 0.10 + 0.20 yesterday plus 0.05 today: the 30-day window contains all three,
  // and 0.1 + 0.2 + 0.05 is exactly the sum a float would get wrong.
  check("chat's own spend is grouped", Number((chat?.totalCostUsd ?? 0).toFixed(2)), 0.35);
  check("with its call count", chat?.callCount, 3);
  assert("and the dearest feature is reported",
    byFeature.some((f) => f.feature === "campaign_planning"), JSON.stringify(byFeature));

  // ==========================================================================
  console.log("\n=== 3. Averages count distinct people, not events ===\n");
  // ==========================================================================
  // Two anonymous visitors, one of whom came back. The average is per visitor,
  // so three events across two visitors is not three visitors.
  await usage({ anonymousSessionToken: "visitor-a", costUsd: "0.50" });
  await usage({ anonymousSessionToken: "visitor-a", costUsd: "0.50" });
  await usage({ anonymousSessionToken: "visitor-b", costUsd: "2.00" });

  const visitors = await averageCostPerVisitor(since);
  check("two distinct visitors, not three events", visitors.visitorCount, 2);
  check("and the average is per visitor", Number(visitors.avgCostUsd.toFixed(2)), 1.5);

  // A second store, so "per customer" is genuinely a distinct count.
  const other = await prisma.store.create({
    data: {
      userId: owner.id, name: "Other Usage", slug: "other-usage",
      tagline: "t", description: "d", currency: "USD",
    },
  });
  await usage({ storeId: other.id, feature: "chat", costUsd: "0.20" });

  const customers = await averageCostPerCustomer(since);
  check("two stores have spent", customers.customerCount, 2);
  assert("and the average is across both, not per event",
    Math.abs(customers.avgCostUsd - (1.85 + 0.2) / 2) < 0.0001, String(customers.avgCostUsd));

  // ==========================================================================
  console.log("\n=== 4. Only accepted sessions count as created businesses ===\n");
  // ==========================================================================
  // The conversion-weighted number: among anonymous sessions that actually led
  // to a kept business, what did that business cost. A session that was
  // abandoned cost real money and created nothing, and must not be averaged in.
  await usage({ sessionId: "kept-1", outcome: "accepted", costUsd: "3.00" });
  await usage({ sessionId: "kept-1", outcome: "accepted", costUsd: "1.00" });
  await usage({ sessionId: "abandoned-1", outcome: "rejected", costUsd: "9.00" });
  await usage({ sessionId: "abandoned-2", costUsd: "9.00" });

  const created = await averageCostPerCreatedBusiness(since);
  check("only the kept session counts as a business", created.businessCount, 1);
  check("costing what it actually cost", Number(created.avgCostUsd.toFixed(2)), 4);
  assert(
    "the abandoned sessions are excluded rather than averaged in",
    created.avgCostUsd < 9,
    "including them would make a created business look far dearer than it is"
  );

  // ==========================================================================
  console.log("\n=== 5. Revenue against cost, once there is revenue ===\n");
  // ==========================================================================
  await prisma.order.create({
    data: {
      storeId: store.id, productName: "x", buyerEmail: "b@example.test",
      amountInCents: 10_000, status: "paid", paymentProvider: "STRIPE",
      externalOrderId: "u-1", createdAt: daysAgo(1),
    },
  });
  // An unpaid order is not revenue.
  await prisma.order.create({
    data: {
      storeId: store.id, productName: "x", buyerEmail: "b@example.test",
      amountInCents: 999_999, status: "pending", paymentProvider: "STRIPE",
      externalOrderId: "u-2", createdAt: daysAgo(1),
    },
  });

  const compared = await revenueVsAiCost(since);
  check("only paid orders are revenue", compared.totalRevenueUsd, 100);
  assert("the 999,999 pending order is excluded", compared.totalRevenueUsd === 100,
    "it would be unmissable if counted");
  assert("the ratio is now a real number", compared.aiCostAsPercentOfRevenue !== null);
  assert("computed from the real totals",
    Math.abs((compared.aiCostAsPercentOfRevenue ?? 0) - (compared.totalCostUsd / 100) * 100) < 0.01,
    `${compared.aiCostAsPercentOfRevenue} from ${compared.totalCostUsd}`);
  assert("and the margin is revenue minus AI cost",
    Math.abs((compared.grossAiMarginUsd ?? 0) - (100 - compared.totalCostUsd)) < 0.0001,
    String(compared.grossAiMarginUsd));

  // ==========================================================================
  console.log("\n=== 6. The window is a real window ===\n");
  // ==========================================================================
  // Spend from long ago must not appear in a 30-day question.
  await usage({ storeId: store.id, feature: "chat", costUsd: "50.00", occurredAt: daysAgo(120) });
  const stillRecent = await costByFeature(since);
  const chatAgain = stillRecent.find((f) => f.feature === "chat");
  assert("old spend is outside the window",
    (chatAgain?.totalCostUsd ?? 0) < 50, String(chatAgain?.totalCostUsd));
  assert("but it is genuinely in the database",
    (await prisma.aiUsageEvent.count({ where: { costUsd: "50.00" } })) === 1,
    "so the exclusion is the window, not a missing row");

  const wideWindow = await costByFeature(daysAgo(365));
  const chatWide = wideWindow.find((f) => f.feature === "chat");
  assert("and a wider window does include it",
    (chatWide?.totalCostUsd ?? 0) > 50, String(chatWide?.totalCostUsd));

  await prisma.$disconnect();
  await db.close();

  console.log(`\n${failures === 0 ? "All AI-usage assertions passed." : `${failures} assertion(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
