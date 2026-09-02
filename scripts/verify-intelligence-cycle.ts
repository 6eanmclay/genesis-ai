import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prismaSystem } from "@/lib/prisma";
import { INSIGHT_ENGINE_CONSUMER } from "@/lib/intelligence/insights";
import {
  getStoresDueForIntelligence,
  runIntelligenceCycle,
  INTELLIGENCE_MAX_AGE_MS,
} from "@/lib/intelligence/cycle";

// Business Intelligence Engine M1 — the end-to-end check, against real data.
//
// DELIBERATELY FABRICATES NOTHING. It does not seed a fake BusinessEvent, a
// fake store or a fake sale. Every event it reasons about is one a real
// checkout, sync or commerce write already produced, because an event this
// script invented would prove only that this script can write to the database.
// Sean's rule for the milestone — "do not create synthetic data to fill
// missing coverage" — applies to its own tests first.
//
//   npx tsx scripts/verify-intelligence-cycle.ts         read-only report
//   npx tsx scripts/verify-intelligence-cycle.ts --run   actually runs the cycle
//
// Read-only mode is the default on purpose: --run performs the real
// recommendation stage, which can make a real (paid) Claude call when a store's
// review is stale. Nothing here deletes anything, ever.

const RUN = process.argv.includes("--run");

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

async function cursorFor(storeId: string): Promise<bigint> {
  const row = await prismaSystem.businessEventCursor.findFirst({
    where: { storeId, consumerName: INSIGHT_ENGINE_CONSUMER },
    select: { lastProcessedSequence: true },
  });
  return row?.lastProcessedSequence ?? BigInt(0);
}

async function maxSequenceFor(storeId: string): Promise<bigint> {
  const row = await prismaSystem.businessEvent.aggregate({
    where: { storeId },
    _max: { sequence: true },
  });
  return row._max.sequence ?? BigInt(0);
}

async function main(): Promise<void> {
  // Refuses to run against anything but an isolated test database. These
  // suites create, mutate and delete rows — without this, a production
  // DATABASE_URL in the shell was enough to rename a real merchant's product.
  // See scripts/lib/requireTestDatabase.ts.
  await requireTestDatabase(prismaSystem);
  // 1. What first-party activity actually exists, per store, with no
  //    integration involved in the question at all.
  const activity = await prismaSystem.businessEvent.groupBy({
    by: ["storeId", "sourceProvider"],
    _count: true,
  });

  if (activity.length === 0) {
    console.log("No BusinessEvent rows exist on any store — nothing to verify against.");
    console.log("This is a real result, not a failure: the cycle correctly has nothing to do.");
    return;
  }

  console.log("BusinessEvent activity by store and source:");
  for (const a of activity) {
    console.log(`  ${a.storeId}  ${a.sourceProvider.padEnd(12)} ${a._count}`);
  }

  // "internal" is the sourceProvider the native Stripe/PayPal commerce writes
  // use — the definition of first-party here, as opposed to a connector's name.
  const firstParty = activity.filter((a) => a.sourceProvider === "internal");
  console.log(`\nFirst-party (internal) event rows: ${firstParty.reduce((n, a) => n + a._count, 0)}`);

  const due = await getStoresDueForIntelligence(50);
  console.log(`Stores due for an intelligence cycle: ${due.length}`);

  // 2. The M1 claim: a store with unconsumed first-party events is reachable
  //    WITHOUT any connected integration.
  const connectedStores = new Set(
    (
      await prismaSystem.storeIntegration.findMany({
        where: { status: "CONNECTED" },
        select: { storeId: true },
      })
    ).map((r) => r.storeId)
  );
  const dueWithoutIntegration = due.filter((id) => !connectedStores.has(id));
  check(
    "a store with no connected integration can be due for the cycle",
    dueWithoutIntegration.length > 0,
    `${dueWithoutIntegration.length} of ${due.length} due stores have no connector`
  );

  // ============ DUE HAS TWO HONEST REASONS NOW (2026-09-02) =============
  //
  // This asserted that every due store had unconsumed events, which was the
  // whole of the rule when it was written. BI Slice 1 added the second half
  // deliberately: a business whose data has not moved is STILL re-evaluated
  // once its last deterministic pass goes stale, because a condition can
  // become true purely because time passed.
  //
  // So the assertion keeps its real job — a store must be due for a genuine,
  // nameable reason, never for none — and now recognises both reasons. It is
  // not softened to "the cycle ran": a store with neither unconsumed events
  // nor a stale evaluation still fails it.
  for (const storeId of due.slice(0, 3)) {
    const [maxSeq, cursor, store] = await Promise.all([
      maxSequenceFor(storeId),
      cursorFor(storeId),
      prismaSystem.store.findUnique({
        where: { id: storeId },
        select: { lastIntelligenceAt: true },
      }),
    ]);

    const hasUnconsumedEvents = maxSeq > cursor;
    const lastAt = store?.lastIntelligenceAt ?? null;
    const staleByTime =
      lastAt === null || Date.now() - lastAt.getTime() >= INTELLIGENCE_MAX_AGE_MS;
    const reason = hasUnconsumedEvents
      ? "unconsumed events"
      : lastAt === null
        ? "never evaluated"
        : staleByTime
          ? "evaluation is stale"
          : "NO REASON";

    console.log(
      `\n  store ${storeId}: maxSequence=${maxSeq} cursor=${cursor} lag=${maxSeq - cursor}` +
        ` lastIntelligenceAt=${lastAt ? lastAt.toISOString() : "null"} -> ${reason}`
    );
    check("  due store is due for a real reason, not for none",
      hasUnconsumedEvents || staleByTime);
  }

  if (!RUN) {
    console.log("\nRead-only mode. Re-run with --run to execute the cycle and verify consumption.");
    console.log(`\n${failures === 0 ? "ALL PASS (read-only)" : `${failures} FAILED`}`);
    process.exit(failures === 0 ? 0 : 1);
  }

  // 3. Run the real cycle on one real store and prove the event was consumed.
  const target = dueWithoutIntegration[0] ?? due[0];
  if (!target) {
    console.log("\nNo store is due — nothing to run. That is a valid state.");
    return;
  }

  const before = { max: await maxSequenceFor(target), cursor: await cursorFor(target) };
  const unprocessedBefore = await prismaSystem.businessEvent.count({
    where: { storeId: target, processedAt: null },
  });
  console.log(`\nRunning the cycle for ${target} (unprocessed events: ${unprocessedBefore})`);

  const summary = await runIntelligenceCycle(target);
  console.log(`  cycle returned: ok=${summary.ok} insights=${summary.insights}`);

  const after = { max: await maxSequenceFor(target), cursor: await cursorFor(target) };
  const unprocessedAfter = await prismaSystem.businessEvent.count({
    where: { storeId: target, processedAt: null },
  });

  // 4. The event reached the downstream stages: the Insight Engine considered
  //    every pending event (processedAt) and the cursor moved to the log head.
  check(
    "the cycle consumed the store's pending events",
    unprocessedAfter === 0 && unprocessedBefore > 0,
    `unprocessed ${unprocessedBefore} -> ${unprocessedAfter}`
  );
  check(
    "the cursor advanced to the head of the log",
    after.cursor === after.max && after.cursor > before.cursor,
    `cursor ${before.cursor} -> ${after.cursor} (max ${after.max})`
  );

  // 5. And the same events are not processed a second time.
  const dueAgain = await getStoresDueForIntelligence(50);
  check(
    "the store is no longer due after consumption",
    !dueAgain.includes(target),
    `due stores now: ${dueAgain.length}`
  );

  // 6. Whatever the stages produced is real and durable — reported, never
  //    asserted to be non-zero. A quiet store producing nothing is correct.
  const [insightOutputs, observations, beliefs] = await Promise.all([
    prismaSystem.cognitiveOutput.count({ where: { storeId: target, kind: "insight" } }),
    prismaSystem.genesisObservation.count({ where: { storeId: target } }),
    prismaSystem.belief.count({ where: { storeId: target } }),
  ]);
  console.log(
    `\n  durable results for ${target}: insights=${insightOutputs} observations=${observations} beliefs=${beliefs}`
  );
  console.log("  (zero is a valid, honest result — M1 adds no data that isn't real)");

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
