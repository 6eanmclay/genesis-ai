import { startTestDatabase } from "@/scripts/lib/testDatabase";

// The Growth Point ledger's REAL functions, against a real database:
//
//   npx tsx scripts/verify-ledger-live.ts
//
// verify-growth-point-ledger.ts asserts planDeduction, which is the decision.
// This asserts deductGrowthPoints and creditGrowthPointsFromPurchase — the
// actual transactions that move a merchant's money.
//
// The distinction matters. A correct decision wired into a transaction that
// commits the wrong thing is still a defect, and every fix I made to these two
// functions was verified by reading until now.

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

async function main() {
  const db = await startTestDatabase();

  // ONE client, and it must be the app's own.
  //
  // PGlite's socket server queues queries per connection, so two Prisma clients
  // against one instance interleave — and a transaction opened by one is torn
  // down when the other speaks. The ledger runs everything inside
  // prisma.$transaction, so the harness's own client is closed here and every
  // query below goes through the same client the ledger itself uses. That is
  // also the more honest test: it exercises the real client, not a lookalike.
  await db.prisma.$disconnect();

  // lib/prisma.ts builds its client at import time, so the environment has to
  // point at the test database BEFORE the ledger is imported. Hence the dynamic
  // imports.
  process.env.DATABASE_URL = db.url;
  const { deductGrowthPoints, creditGrowthPointsFromPurchase } = await import("@/lib/growthPoints/ledger");
  const { prismaSystem } = await import("@/lib/prisma");
  const raw = prismaSystem;

  // Reset through the same client, for the same reason.
  const reset = async () => {
    const tables = await raw.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
    if (tables.length === 0) return;
    await raw.$executeRawUnsafe(
      `TRUNCATE TABLE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`
    );
  };

  async function makeStore(balance: number, slug: string) {
    const user = await raw.user.create({ data: { email: `${slug}@example.com` } });
    return raw.store.create({
      data: {
        userId: user.id, name: slug, slug, description: "", tagline: "",
        growthPointBalance: balance,
      },
    });
  }
  const balanceOf = async (id: string) =>
    (await raw.store.findUniqueOrThrow({ where: { id }, select: { growthPointBalance: true } })).growthPointBalance;

  async function makeExecutionLog(storeId: string, executionId: string) {
    return raw.executionLog.create({
      data: {
        executionId, action: "test.action", status: "SUCCESS", verified: true,
        message: "ok", retryable: false, actorType: "USER",
        store: { connect: { id: storeId } },
        schemaVersion: 1, metadata: {},
      },
    });
  }

  // -------------------------------------------------------------------------
  console.log("\n1. One execution is charged exactly once, however many times it runs");
  {
    await reset();
    const store = await makeStore(100, "once");
    const log = await makeExecutionLog(store.id, "exec_1");

    const charge = () =>
      deductGrowthPoints({ storeId: store.id, actionType: "update_seo", cost: 10, executionLogId: log.id });

    await charge();
    check("the first charge takes the points", await balanceOf(store.id), 90);

    // The retry. Before the fix this took another ten.
    await charge();
    check("a repeat of the SAME execution takes nothing more", await balanceOf(store.id), 90);
    await charge();
    await charge();
    check("and still nothing after several", await balanceOf(store.id), 90);

    check("only one deduction row exists",
      await raw.growthPointTransaction.count({ where: { storeId: store.id, type: "DEDUCTION" } }), 1);
  }

  // -------------------------------------------------------------------------
  console.log("\n2. A different execution is charged normally");
  {
    await reset();
    const store = await makeStore(100, "twice");
    const a = await makeExecutionLog(store.id, "exec_a");
    const b = await makeExecutionLog(store.id, "exec_b");

    await deductGrowthPoints({ storeId: store.id, actionType: "update_seo", cost: 10, executionLogId: a.id });
    await deductGrowthPoints({ storeId: store.id, actionType: "update_seo", cost: 10, executionLogId: b.id });
    // Idempotency must key on the EXECUTION, not on the action type — otherwise
    // a store could only ever be charged once for any given kind of work.
    check("two different executions are both charged", await balanceOf(store.id), 80);
    check("and both recorded",
      await raw.growthPointTransaction.count({ where: { storeId: store.id, type: "DEDUCTION" } }), 2);
  }

  // -------------------------------------------------------------------------
  console.log("\n3. The balance never goes below zero");
  {
    await reset();
    const store = await makeStore(5, "short");
    const log = await makeExecutionLog(store.id, "exec_short");

    await deductGrowthPoints({ storeId: store.id, actionType: "update_seo", cost: 10, executionLogId: log.id });

    const after = await balanceOf(store.id);
    check("an unaffordable charge leaves the balance alone", after, 5);
    assert("and never negative", after >= 0, String(after));

    // But it is RECORDED — the work happened, and a silent nothing would hide
    // that from the owner's own history.
    const rows = await raw.growthPointTransaction.findMany({ where: { storeId: store.id } });
    check("the shortfall is written to the ledger", rows.length, 1);
    check("at zero, not at the cost", rows[0].amount, 0);
    assert("and says why", rows[0].description.toLowerCase().includes("not charged"), rows[0].description);
  }

  // -------------------------------------------------------------------------
  console.log("\n4. Exactly affordable still charges");
  {
    await reset();
    const store = await makeStore(10, "exact");
    const log = await makeExecutionLog(store.id, "exec_exact");
    await deductGrowthPoints({ storeId: store.id, actionType: "update_seo", cost: 10, executionLogId: log.id });
    // An off-by-one here makes every action at the boundary free.
    check("a balance equal to the cost is spent to zero", await balanceOf(store.id), 0);
    const row = await raw.growthPointTransaction.findFirstOrThrow({ where: { storeId: store.id } });
    check("recorded as a real charge", row.amount, -10);
    check("with an honest balanceAfter", row.balanceAfter, 0);
  }

  // -------------------------------------------------------------------------
  console.log("\n5. A redelivered purchase credits once");
  {
    await reset();
    const store = await makeStore(0, "buyer");
    const session = "cs_live_1";

    const first = await creditGrowthPointsFromPurchase({
      storeId: store.id, amount: 500, externalRef: session, description: "Purchased 500",
    });
    check("the first credit lands", first, { credited: true });
    check("balance reflects it", await balanceOf(store.id), 500);

    // Stripe redelivers the same event.
    const replay = await creditGrowthPointsFromPurchase({
      storeId: store.id, amount: 500, externalRef: session, description: "Purchased 500",
    });
    check("the replay is a no-op", replay, { credited: false });
    check("and the balance did not double", await balanceOf(store.id), 500);
    check("one purchase row only",
      await raw.growthPointTransaction.count({ where: { storeId: store.id, type: "PURCHASE" } }), 1);

    // A genuinely different purchase must still credit.
    await creditGrowthPointsFromPurchase({
      storeId: store.id, amount: 200, externalRef: "cs_live_2", description: "Purchased 200",
    });
    check("a second real purchase credits", await balanceOf(store.id), 700);
  }

  // -------------------------------------------------------------------------
  console.log("\n6. Points are conserved across a mixed sequence");
  {
    await reset();
    const store = await makeStore(0, "mixed");
    await creditGrowthPointsFromPurchase({ storeId: store.id, amount: 100, externalRef: "cs_m1", description: "buy" });

    for (const id of ["m_a", "m_b", "m_c"]) {
      const log = await makeExecutionLog(store.id, id);
      await deductGrowthPoints({ storeId: store.id, actionType: "update_seo", cost: 10, executionLogId: log.id });
      // Every one repeated, to make sure retries never leak points.
      await deductGrowthPoints({ storeId: store.id, actionType: "update_seo", cost: 10, executionLogId: log.id });
    }

    const balance = await balanceOf(store.id);
    check("three charges from a hundred, retries and all", balance, 70);

    // The ledger must reconcile to the balance, or history is fiction.
    const rows = await raw.growthPointTransaction.findMany({ where: { storeId: store.id } });
    const sum = rows.reduce((total, row) => total + row.amount, 0);
    check("the ledger sums to the balance", sum, balance);
    check("and the last row's balanceAfter agrees", rows[rows.length - 1].balanceAfter, balance);
  }

  await raw.$disconnect();
  await db.close();
  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
