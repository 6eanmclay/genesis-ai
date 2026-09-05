// THE PLATFORM OPERATOR'S OWN BUSINESS IS NOT A CUSTOMER (2026-09-05).
//
//   npx tsx scripts/run-db-suites.ts platform-exemption
//
// Genesis runs its own store through Genesis. Metering the operator against the
// customer credit system means the platform's own operational work stops when a
// customer-facing balance runs out - a billing rule applied to something that
// was never being billed.
//
// Sean's boundary for this, and the reason the exemption is HERE and not in the
// UI: "Server-side enforcement at the ledger/authorization layer. No UI
// suppression or fake balance." So it is a third `unlimitedSource` beside plan
// and trial, and everything that makes those honest applies to it - a covered
// action still writes a real transaction, at zero, naming which mechanism
// covered it.
//
// He drew the other boundary just as firmly: this is NOT the answer to an
// Anthropic billing error, which is a provider-level problem and not a Genesis
// authorization one. Nothing here touches that.

// SET BEFORE THE LEDGER IS IMPORTED. The policy reads the variable when it is
// asked, not at module load, but ordering it this way keeps the suite honest if
// that ever changes.
const OPERATOR = "operator@genesis.test";
process.env.PLATFORM_ADMIN_EMAILS = OPERATOR;

import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import {
  checkGrowthPointBalance,
  checkGrowthPointBalanceForActions,
  deductGrowthPoints,
} from "@/lib/growthPoints/ledger";
import { growthPointCostFor } from "@/lib/growthPoints/catalog";

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const ACTION = "create_product" as const;

async function storeFor(email: string, label: string): Promise<string> {
  const user = await prisma.user.create({ data: { email, name: label } });
  const store = await prisma.store.create({
    data: {
      userId: user.id,
      name: label,
      slug: `${label.toLowerCase().replace(/[^a-z]+/g, "-")}-${Date.now()}`,
      // DELIBERATELY BROKE. The exemption has to hold when the balance cannot
      // pay, or it is not an exemption - it is a coincidence.
      growthPointBalance: 0,
    },
  });
  return store.id;
}

async function logFor(storeId: string, note: string): Promise<string> {
  const log = await prisma.executionLog.create({
    data: {
      executionId: `platform-${note}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      storeId,
      action: `genesis.${ACTION}`,
      status: "SUCCESS",
      message: note,
      actorType: "GENESIS",
    },
  });
  return log.id;
}

async function main(): Promise<void> {
  await requireTestDatabase(prismaSystem);

  const cost = growthPointCostFor(ACTION);
  check("the action under test really costs something", typeof cost === "number" && cost > 0, String(cost));
  if (typeof cost !== "number") {
    console.log("\n0/1 passed");
    process.exitCode = 1;
    return;
  }

  const stamp = Date.now();
  const operatorStore = await storeFor(OPERATOR, "Genesis Operator");
  const customerStore = await storeFor(`customer-${stamp}@example.test`, "A Real Customer");
  const stores = [operatorStore, customerStore];

  try {
    // ---- the single-action rail -------------------------------------------
    const operatorGate = await checkGrowthPointBalance(operatorStore, ACTION);
    check("the operator is authorised on an empty balance", operatorGate.ok,
      `balance ${operatorGate.balance}, cost ${operatorGate.cost}`);

    // THE CONTROL. Without it this suite would pass just as happily against a
    // ledger that had stopped charging anybody at all.
    const customerGate = await checkGrowthPointBalance(customerStore, ACTION);
    check("a real customer on an empty balance is still refused", !customerGate.ok,
      `balance ${customerGate.balance}, cost ${customerGate.cost}`);

    // ---- the group rail ----------------------------------------------------
    // THE RAIL THAT WAS MISSING. checkGrowthPointBalanceForActions is what
    // approve-all uses, and it carried the plan and trial exemptions but not
    // this one - so the same work was covered approved one at a time and
    // charged approved together. Two rails, one rule.
    const operatorGroup = await checkGrowthPointBalanceForActions(operatorStore, [ACTION, ACTION, ACTION]);
    check("the operator is authorised for a whole group too", operatorGroup.ok && operatorGroup.totalCost === 0,
      `total cost ${operatorGroup.totalCost}`);
    const customerGroup = await checkGrowthPointBalanceForActions(customerStore, [ACTION, ACTION, ACTION]);
    check("and a real customer's group is still priced", !customerGroup.ok && customerGroup.totalCost === cost * 3,
      `total cost ${customerGroup.totalCost}`);

    // ---- the debit ---------------------------------------------------------
    await deductGrowthPoints({
      storeId: operatorStore,
      actionType: ACTION,
      cost,
      executionLogId: await logFor(operatorStore, "operator work"),
    });
    const operatorAfter = await prisma.store.findUniqueOrThrow({ where: { id: operatorStore } });
    check("the operator's balance is untouched", operatorAfter.growthPointBalance === 0,
      String(operatorAfter.growthPointBalance));

    // COVERED IS NOT UNRECORDED. The same rule the plan and trial tiers already
    // hold to: the owner's history still says what Genesis did.
    const entry = await prisma.growthPointTransaction.findFirst({
      where: { storeId: operatorStore, type: "DEDUCTION" },
      orderBy: { createdAt: "desc" },
    });
    check("a covered action still writes a real ledger entry", entry !== null, entry?.description ?? "no entry");
    check("recorded at zero", entry?.amount === 0, String(entry?.amount));
    // NAMED, not merged into the plan wording - the operator is not on a plan,
    // and an owner reading their own history should see what actually happened.
    check("and it names the platform account rather than borrowing a plan's wording",
      entry?.description === "Covered by the Genesis platform account",
      entry?.description ?? "");

    // ---- it fails closed ---------------------------------------------------
    // An unconfigured deployment has NO operators, rather than everybody being
    // one. This is the direction the rule has to fail in, and it is the whole
    // reason the allowlist is read per call rather than captured at import.
    process.env.PLATFORM_ADMIN_EMAILS = "";
    const unconfigured = await checkGrowthPointBalance(operatorStore, ACTION);
    check("with no allowlist configured, nobody is exempt", !unconfigured.ok,
      `balance ${unconfigured.balance}`);
    process.env.PLATFORM_ADMIN_EMAILS = OPERATOR;

    // ---- and it is the EMAIL that decides, not the store -------------------
    // A lookalike must not be admitted. The policy matches exactly after
    // normalisation, and this is the case that proves the ledger asks the
    // policy rather than doing its own comparison.
    const lookalike = await storeFor(`${OPERATOR}.evil.com`, "Lookalike");
    stores.push(lookalike);
    const lookalikeGate = await checkGrowthPointBalance(lookalike, ACTION);
    check("a lookalike address is not the operator", !lookalikeGate.ok, `${OPERATOR}.evil.com`);
  } finally {
    // Tolerant: a cleanup failure must never be the only thing this reports.
    await prisma.growthPointTransaction.deleteMany({ where: { storeId: { in: stores } } }).catch(() => {});
    await prisma.executionLog.deleteMany({ where: { storeId: { in: stores } } }).catch(() => {});
    const owners = await prisma.store.findMany({ where: { id: { in: stores } }, select: { userId: true } });
    await prisma.store.deleteMany({ where: { id: { in: stores } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: owners.map((o) => o.userId) } } }).catch(() => {});
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
