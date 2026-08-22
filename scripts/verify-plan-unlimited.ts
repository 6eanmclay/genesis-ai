import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { checkGrowthPointBalance, deductGrowthPoints } from "@/lib/growthPoints/ledger";
import { growthPointCostFor } from "@/lib/growthPoints/catalog";

// THE BUSINESS PARTNER PLAN'S UNLIMITED TIER, END TO END:
//
//   npx tsx scripts/run-db-suites.ts
//
// The trial path has coverage (verify-trial-live.ts). The PLAN path — a store
// whose planId points at Business Partner — did not, and it is the one an owner
// actually pays $99.99 a month for.
//
// Sean's framing for what the tier is: "The purpose of the Business Partner
// plan is not to remove the Growth Point economy. It's to eliminate friction
// from the routine, day-to-day improvements... while preserving intentional
// investment for larger business decisions."
//
// So the tier has TWO halves and both must hold. Routine work must be free, and
// significant work must still cost — a ceiling that swallowed everything would
// "defeat the point of the economy representing meaningful business
// investment", and one that swallowed nothing would be a plan that changed
// nothing. The real costs straddle the real ceiling exactly: update_seo is 1,
// create_product is 2, update_store_identity is 3.
//
// AND FREE IS NOT UNRECORDED. A covered action still writes its ledger entry,
// at zero. An owner on this plan must still be able to see what Genesis did on
// their behalf; a tier that skipped the record would buy silence rather than
// convenience.

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

async function main() {
  await requireTestDatabase(prismaSystem);

  // The real plan row, as provision-pricing.ts creates it. Read rather than
  // invented: the ceiling is a product decision and this suite must assert
  // against whatever it currently is, not against a number copied here.
  const businessPartner = await prisma.plan.upsert({
    where: { name: "Business Partner" },
    update: {},
    create: { name: "Business Partner", priceInCents: 9999, monthlyGrowthPointAllowance: 40, unlimitedActionCostCeiling: 2 },
  });
  const ceiling = businessPartner.unlimitedActionCostCeiling;
  check("the plan declares a real unlimited ceiling",
    typeof ceiling === "number" && ceiling > 0, String(ceiling));
  if (typeof ceiling !== "number") {
    console.log("\n0/1 passed");
    process.exitCode = 1;
    return;
  }

  const user = await prisma.user.create({
    data: { email: `plan-${Date.now()}@test.local`, name: "Owner" },
  });
  const stores: string[] = [];
  const store = async (over: Record<string, unknown> = {}) => {
    const created = await prisma.store.create({
      data: {
        userId: user.id,
        name: "Copper & Coil",
        slug: `plan-${Math.random().toString(36).slice(2)}`,
        growthPointBalance: 0,
        ...over,
      },
    });
    stores.push(created.id);
    return created;
  };

  try {
    // ========================================================================
    console.log("\n=== 1. Routine work costs nothing, with no balance at all ===\n");
    // ========================================================================
    // The whole point: an owner on this plan is not stopped by a zero balance
    // for the day-to-day.
    const member = await store({ planId: businessPartner.id });
    const atOrBelow = (["update_seo", "create_product"] as const).filter(
      (a) => (growthPointCostFor(a) ?? 99) <= ceiling
    );
    check("there are real actions at or below the ceiling", atOrBelow.length > 0, JSON.stringify(atOrBelow));

    for (const action of atOrBelow) {
      const gate = await checkGrowthPointBalance(member.id, action);
      check(`${action} (${growthPointCostFor(action)}pt) is allowed on a zero balance`, gate.ok,
        JSON.stringify(gate));
      check(`and its real cost is still reported`, gate.cost === growthPointCostFor(action),
        String(gate.cost));
    }

    // ========================================================================
    console.log("\n=== 2. Significant work still costs ===\n");
    // ========================================================================
    // "Preserving intentional investment for larger business decisions." A
    // ceiling that swallowed everything would defeat the economy it sits inside.
    const above = (["update_store_identity"] as const).filter(
      (a) => (growthPointCostFor(a) ?? 0) > ceiling
    );
    check("there are real actions above the ceiling", above.length > 0, JSON.stringify(above));

    for (const action of above) {
      const gate = await checkGrowthPointBalance(member.id, action);
      check(`${action} (${growthPointCostFor(action)}pt) is refused on a zero balance`, !gate.ok,
        JSON.stringify(gate));
    }

    // With a balance, the same action is allowed — so the refusal above is the
    // balance talking, not the plan blocking it.
    const funded = await store({ planId: businessPartner.id, growthPointBalance: 50 });
    for (const action of above) {
      const gate = await checkGrowthPointBalance(funded.id, action);
      check(`${action} is allowed once the store can afford it`, gate.ok, JSON.stringify(gate));
    }

    // ========================================================================
    console.log("\n=== 3. A plan is not a trial, and neither is a plan ===\n");
    // ========================================================================
    // A store on no plan at all pays for everything, which is what makes the
    // tier worth anything.
    const unplanned = await store();
    for (const action of atOrBelow) {
      const gate = await checkGrowthPointBalance(unplanned.id, action);
      check(`${action} is refused for a store on no plan with no balance`, !gate.ok,
        JSON.stringify(gate));
    }
    check("so the ceiling is genuinely the plan's doing",
      (await checkGrowthPointBalance(member.id, atOrBelow[0])).ok &&
        !(await checkGrowthPointBalance(unplanned.id, atOrBelow[0])).ok,
      "same action, same zero balance, different plan");

    // ========================================================================
    console.log("\n=== 4. Free is recorded, not unrecorded ===\n");
    // ========================================================================
    // A REAL ExecutionLog row. GrowthPointTransaction.executionLogId is a
    // foreign key, and an invented id fails as Prisma's "depends on one or more
    // records that were required but not found" — which reads like a missing
    // query rather than the FK it is. The first run of this suite spent a while
    // looking in the wrong place for it.
    const log = await prisma.executionLog.create({
      data: {
        executionId: `run-${Date.now()}`,
        storeId: member.id,
        action: "genesis.store_message",
        status: "SUCCESS",
        message: "A covered action",
        actorType: "GENESIS",
      },
    });
    const executionLogId = log.id;
    // Caught rather than awaited bare: a throw here would take the suite down
    // and report nothing about WHICH property broke, which is exactly what the
    // first run did.
    const deducted = await deductGrowthPoints({
      storeId: member.id,
      actionType: atOrBelow[0],
      cost: growthPointCostFor(atOrBelow[0]) ?? 0,
      executionLogId,
    }).then(() => null, (e: unknown) => (e instanceof Error ? e.message : String(e)));
    check("a covered deduction completes without throwing", deducted === null, String(deducted));

    const after = await prisma.store.findUniqueOrThrow({ where: { id: member.id } });
    check("the balance did not move", after.growthPointBalance === 0, String(after.growthPointBalance));

    const entries = await prisma.growthPointTransaction.findMany({ where: { storeId: member.id } });
    check("but a ledger entry was written", entries.length === 1, String(entries.length));
    check("at zero", entries[0]?.amount === 0, String(entries[0]?.amount));
    check("saying it came with the plan",
      entries[0]?.description === "Included with your plan", String(entries[0]?.description));
    check(
      "so an owner on this plan can still see what Genesis did for them",
      entries.length === 1,
      "a tier that skipped the record would buy silence rather than convenience"
    );

    // And charging twice for one execution is still impossible, plan or not.
    await deductGrowthPoints({
      storeId: member.id,
      actionType: atOrBelow[0],
      cost: growthPointCostFor(atOrBelow[0]) ?? 0,
      executionLogId,
    });
    const again = await prisma.growthPointTransaction.findMany({ where: { storeId: member.id } });
    check("and the same execution is never recorded twice", again.length === 1, String(again.length));

    // ========================================================================
    console.log("\n=== 5. A charged action on the same plan still charges ===\n");
    // ========================================================================
    const chargeable = above[0];
    const cost = growthPointCostFor(chargeable) ?? 0;
    await deductGrowthPoints({
      storeId: funded.id,
      actionType: chargeable,
      cost,
      executionLogId: (
        await prisma.executionLog.create({
          data: {
            executionId: `run-charge-${Date.now()}`,
            storeId: funded.id,
            action: "genesis.store_message",
            status: "SUCCESS",
            message: "A charged action",
            actorType: "GENESIS",
          },
        })
      ).id,
    });
    const fundedAfter = await prisma.store.findUniqueOrThrow({ where: { id: funded.id } });
    check(`${chargeable} really took ${cost} points`, fundedAfter.growthPointBalance === 50 - cost,
      String(fundedAfter.growthPointBalance));
    check(
      "so the plan removes friction from the routine without removing the economy",
      fundedAfter.growthPointBalance < 50,
      "unlimited everything would defeat the point of the economy representing meaningful investment"
    );
  } finally {
    // Tolerant on purpose: a cleanup failure must never be the only thing this
    // suite reports, which is what happened on its first run.
    await prisma.store.deleteMany({ where: { id: { in: stores } } }).catch(() => {});
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
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
