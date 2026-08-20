import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import "dotenv/config";
import { prismaSystem } from "../lib/prisma";
import {
  adjustGrowthPointBalance,
  checkGrowthPointBalance,
  checkGrowthPointBalanceForActions,
} from "../lib/growthPoints/ledger";

// Real verification (2026-08-09) — Sean's own P0/P1 framing: "do not let
// Growth Points become a blocker that makes the product impossible to
// test." Run against the real database, against a real store, restoring
// its original balance afterward so this never leaves test data behind
// (see the "test data safety" standing rule).
async function main() {
  // Refuses to run against anything but an isolated test database. These
  // suites create, mutate and delete rows — without this, a production
  // DATABASE_URL in the shell was enough to rename a real merchant's product.
  // See scripts/lib/requireTestDatabase.ts.
  await requireTestDatabase(prismaSystem);
  const store = await prismaSystem.store.findFirst({
    select: { id: true, growthPointBalance: true },
  });
  if (!store) throw new Error("No real store found to test against");

  const originalBalance = store.growthPointBalance;

  try {
    // Case 1: adjustGrowthPointBalance actually credits the store and
    // writes exactly one real ADJUSTMENT transaction row.
    const before = await prismaSystem.growthPointTransaction.count({ where: { storeId: store.id } });
    const { balanceAfter } = await adjustGrowthPointBalance({
      storeId: store.id,
      amount: 100,
      adjustedByLabel: "verify-script@test",
    });
    if (balanceAfter !== originalBalance + 100) {
      throw new Error(`Case 1 FAILED: expected balance ${originalBalance + 100}, got ${balanceAfter}`);
    }
    const after = await prismaSystem.growthPointTransaction.count({ where: { storeId: store.id } });
    if (after !== before + 1) throw new Error(`Case 1 FAILED: expected exactly 1 new transaction row, got ${after - before}`);
    const txRow = await prismaSystem.growthPointTransaction.findFirst({
      where: { storeId: store.id, type: "ADJUSTMENT" },
      orderBy: { createdAt: "desc" },
    });
    if (!txRow || txRow.amount !== 100 || !txRow.description.includes("verify-script@test")) {
      throw new Error(`Case 1 FAILED: ADJUSTMENT row missing or malformed: ${JSON.stringify(txRow)}`);
    }
    console.log("Case 1 (adjustGrowthPointBalance credits balance + writes one honest ADJUSTMENT row): PASS");

    // Case 2: checkGrowthPointBalance now returns a real, non-null balance
    // alongside cost for a priced action (this is the new field the
    // shortfall-messaging fix in lib/execution/engine.ts depends on).
    const gate = await checkGrowthPointBalance(store.id, "update_seo");
    if (gate.cost !== 1) throw new Error(`Case 2 FAILED: expected update_seo cost 1, got ${gate.cost}`);
    if (gate.balance !== originalBalance + 100) {
      throw new Error(`Case 2 FAILED: expected balance ${originalBalance + 100}, got ${gate.balance}`);
    }
    console.log("Case 2 (checkGrowthPointBalance returns real cost + real balance): PASS");

    // Case 3: an unpriced action reports null/null, never a false balance
    // lookup — matches the "honest null" convention throughout this file.
    const freeGate = await checkGrowthPointBalance(store.id, "communicate_finding");
    if (freeGate.cost !== null || freeGate.balance !== null) {
      throw new Error(`Case 3 FAILED: expected {cost: null, balance: null} for an unpriced action, got ${JSON.stringify(freeGate)}`);
    }
    console.log("Case 3 (unpriced action reports honest null cost/balance): PASS");

    // Case 4: checkGrowthPointBalanceForActions — a real group of 3 priced
    // actions the store can genuinely afford, sums correctly and passes.
    const affordableGroup = await checkGrowthPointBalanceForActions(store.id, [
      "update_seo", // 1
      "update_hero", // 2
      "update_store_content", // 2
    ]);
    if (affordableGroup.totalCost !== 5) {
      throw new Error(`Case 4 FAILED: expected totalCost 5, got ${affordableGroup.totalCost}`);
    }
    if (!affordableGroup.ok) {
      throw new Error(`Case 4 FAILED: expected an affordable group to pass, balance=${affordableGroup.balance}`);
    }
    console.log("Case 4 (checkGrowthPointBalanceForActions sums a real group's cost and passes when affordable): PASS");

    // Case 5: force the store to a real, known-low balance and confirm the
    // SAME group now correctly reports insufficient with an honest
    // shortfall — this is the exact pre-check performApproveGenesisActionGroup
    // now runs before executing any group member.
    await prismaSystem.store.update({ where: { id: store.id }, data: { growthPointBalance: 2 } });
    const shortGroup = await checkGrowthPointBalanceForActions(store.id, [
      "update_seo", // 1
      "update_hero", // 2
      "update_store_content", // 2
    ]);
    if (shortGroup.ok) throw new Error("Case 5 FAILED: expected an unaffordable group to fail");
    if (shortGroup.totalCost - shortGroup.balance !== 3) {
      throw new Error(`Case 5 FAILED: expected shortfall 3, got totalCost=${shortGroup.totalCost} balance=${shortGroup.balance}`);
    }
    console.log("Case 5 (checkGrowthPointBalanceForActions correctly blocks + reports a real shortfall): PASS");

    console.log("\nAll Growth Points unblock assertions passed.");
  } finally {
    // Restore the store's real balance exactly — never leave test data behind.
    await prismaSystem.store.update({ where: { id: store.id }, data: { growthPointBalance: originalBalance } });
    await prismaSystem.growthPointTransaction.deleteMany({
      where: { storeId: store.id, description: { contains: "verify-script@test" } },
    });
  }
}

main()
  .catch((err) => {
    console.error("FAILED:", err);
    process.exitCode = 1;
  })
  .finally(() => prismaSystem.$disconnect());
