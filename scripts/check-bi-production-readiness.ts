import { existsSync } from "fs";
import * as dotenv from "dotenv";

// IS THE INTELLIGENCE ENGINE ACTUALLY RUNNING, AND ON WHAT DATA?
//
//   npx tsx scripts/check-bi-production-readiness.ts path/to/production.env
//
// READ-ONLY. Writes nothing, to the database or anywhere else. Safe to run
// against production repeatedly. Same shape and the same reasoning as
// check-stripe-live-readiness.ts, deliberately — including the env-file
// argument, so a live connection string never goes through shell history.
//
// WHY THIS EXISTS. Every suite in this repository named "live" runs against an
// embedded Postgres with engineered rows. That is honest and it is also the
// limit: "live" here has always meant "a real database", never "the production
// database". BI_ENGINE.md §15 leaves two questions explicitly open for exactly
// that reason, and both of them feed arithmetic that reaches what J4 tells an
// owner:
//
//   - does any real order carry shippingCostInCents?
//   - which Order.status values actually occur?
//
// A wrong assumption about either does not produce a slightly-off dashboard. It
// produces J4 telling somebody their margin, confidently, from a number that
// was never there. lib/businessModel/profitability.ts is built so a missing
// cost is an EXCLUSION and never a zero — this measures how much is being
// excluded, which nothing has ever asked production.
//
// It also answers the question that had no answer at all: whether the daily
// cycle is running. /api/cron/status now reports this too; this script is the
// same read without needing the deployment to be up.
//
// NOTHING HERE INTERPRETS. Every number below is counted, and a zero is
// reported as a zero rather than as an absence — telling those apart is the
// whole point of running it.

const envFile = process.argv[2];
if (envFile) {
  if (!existsSync(envFile)) {
    console.error(`No such env file: ${envFile}`);
    process.exit(1);
  }
  dotenv.config({ path: envFile, override: true });
  console.log(`Loaded environment from: ${envFile}\n`);
} else {
  dotenv.config();
  console.log("No env file named — using the ambient environment.\n");
  console.log("This is almost certainly your DEV database. Pass a production");
  console.log("env file as the first argument to ask production.\n");
}

const pct = (n: number, of: number) => (of === 0 ? "—" : `${Math.round((n / of) * 100)}%`);

async function main() {
  const { prismaSystem } = await import("@/lib/prisma");
  const { INSIGHT_ENGINE_CONSUMER } = await import("@/lib/intelligence/insights");
  const { EXECUTION_ACTIONS } = await import("@/lib/execution/actions");

  console.log("=".repeat(66));
  console.log("1. IS THE ENGINE RUNNING?");
  console.log("=".repeat(66));

  const [activity, cursors, stores] = await Promise.all([
    prismaSystem.businessEvent.groupBy({ by: ["storeId"], _max: { sequence: true } }),
    prismaSystem.businessEventCursor.findMany({
      where: { consumerName: INSIGHT_ENGINE_CONSUMER },
      select: { storeId: true, lastProcessedSequence: true, updatedAt: true },
    }),
    prismaSystem.store.findMany({ select: { id: true, name: true } }),
  ]);
  const name = new Map(stores.map((s) => [s.id, s.name]));
  const consumed = new Map(cursors.map((c) => [c.storeId, c]));

  console.log(`\nstores: ${stores.length}`);
  console.log(`stores with any business event: ${activity.length}`);
  console.log(`stores the Insight Engine has a cursor for: ${cursors.length}`);

  // A store with events and NO cursor has never been processed at all. That is
  // the shape of "the engine has never run here", and it is different from
  // "it ran and found nothing" in a way a count of insights cannot show.
  const never = activity.filter((a) => !consumed.has(a.storeId));
  console.log(`\nstores with events but NO cursor (never processed): ${never.length}`);
  for (const a of never.slice(0, 20)) {
    console.log(`  ${name.get(a.storeId) ?? a.storeId}  newest event #${a._max.sequence}`);
  }

  const behind = activity
    .map((a) => {
      const c = consumed.get(a.storeId);
      return {
        storeId: a.storeId,
        lag: Number((a._max.sequence ?? BigInt(0)) - (c?.lastProcessedSequence ?? BigInt(0))),
        at: c?.updatedAt ?? null,
      };
    })
    .filter((r) => r.lag > 0)
    .sort((a, b) => b.lag - a.lag);
  console.log(`\nstores with unconsumed events (lag > 0): ${behind.length}`);
  for (const r of behind.slice(0, 20)) {
    console.log(`  ${name.get(r.storeId) ?? r.storeId}  lag ${r.lag}  cursor last moved ${r.at?.toISOString() ?? "never"}`);
  }

  console.log("\n" + "=".repeat(66));
  console.log("2. WHAT DID IT CONCLUDE, AND WHEN?");
  console.log("=".repeat(66));

  const [outputs, reviews] = await Promise.all([
    prismaSystem.cognitiveOutput.groupBy({
      by: ["storeId"],
      _max: { generatedAt: true },
      _count: { _all: true },
    }),
    prismaSystem.executionLog.findMany({
      where: { action: EXECUTION_ACTIONS.GENESIS_RECOMMENDATIONS_GENERATE },
      select: { storeId: true, status: true, message: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
  ]);
  console.log(`\nstores with any cognitive output: ${outputs.length}`);
  for (const o of outputs.slice(0, 20)) {
    console.log(`  ${name.get(o.storeId) ?? o.storeId}  ${o._count._all} output(s)  latest ${o._max?.generatedAt?.toISOString() ?? "—"}`);
  }

  const byStatus = new Map<string, number>();
  for (const r of reviews) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
  console.log(`\nAI review runs (most recent ${reviews.length}):`);
  for (const [status, count] of byStatus) console.log(`  ${status}: ${count}`);
  const lastFailure = reviews.find((r) => r.status === "FAILED");
  if (lastFailure) {
    console.log(`\n  most recent failure: ${lastFailure.createdAt.toISOString()}`);
    console.log(`  ${lastFailure.message}`);
  }

  console.log("\n" + "=".repeat(66));
  console.log("3. THE TWO OPEN QUESTIONS FROM BI_ENGINE.md §15");
  console.log("=".repeat(66));

  // WHICH ORDER STATUSES ACTUALLY OCCUR. obligations.ts counts an unrecognised
  // status and NAMES it rather than assuming it is an obligation. This is the
  // list nothing has ever checked that logic against.
  const statuses = await prismaSystem.order.groupBy({
    by: ["status"],
    _count: { _all: true },
  });
  const totalOrders = statuses.reduce((n, s) => n + s._count._all, 0);
  console.log(`\norders: ${totalOrders}`);
  console.log("Order.status values that actually occur:");
  for (const s of statuses.sort((a, b) => b._count._all - a._count._all)) {
    console.log(`  ${String(s.status).padEnd(24)} ${s._count._all}  (${pct(s._count._all, totalOrders)})`);
  }

  // HOW MUCH OF THE MARGIN ARITHMETIC HAS A COST TO WORK FROM. A missing
  // shipping cost is an exclusion, never a zero — so this is the size of what
  // is being excluded, which decides whether the number J4 quotes means
  // anything yet.
  const [withShipping, withoutShipping] = await Promise.all([
    prismaSystem.order.count({ where: { NOT: { shippingCostInCents: null } } }),
    prismaSystem.order.count({ where: { shippingCostInCents: null } }),
  ]);
  console.log(`\norders carrying shippingCostInCents: ${withShipping}  (${pct(withShipping, totalOrders)})`);
  console.log(`orders with none — EXCLUDED from net-of-postage, not counted as zero: ${withoutShipping}`);
  if (withShipping === 0 && totalOrders > 0) {
    console.log("\n  Every order is excluded. planNetOfPostage returns null for this store set,");
    console.log("  which is the honest answer and not a defect — but it means the");
    console.log("  net-of-postage read has never had real production input.");
  }

  console.log("\n" + "=".repeat(66));
  console.log("Read-only. Nothing was written.");
  console.log("=".repeat(66));
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
