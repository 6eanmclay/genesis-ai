import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";

// GROWTH POINTS AND BILLING, ACROSS TWO BUSINESSES:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-growth-points-live.ts" -OutFile out.txt
//
// The last surface BUSINESS_CONTEXT.md Phase E names without dedicated coverage,
// and the one where being wrong is least recoverable: Growth Points are bought
// with real money and spent on real work. A balance credited to the wrong
// business is not a display bug — the owner paid for something another business
// received.
//
// THE DEFECT THIS FOUND. rewardReferralIfEligible picked the referred owner's
// business by MOST-RECENTLY-UPDATED. Its own comment said so: "a defensible
// answer, not a correct one", deferred to the business-context work that has
// since landed. Recency is exactly the mechanism that work removed everywhere
// else, and here it decided where real Growth Points went.
//
// Everything else on this surface traced clean, and is asserted rather than
// assumed: purchase and subscription both carry an explicit storeId from
// requireBusinessOrActive into Stripe metadata, and the webhook credits that
// storeId back. The chain is explicit end to end; this proves the ledger half.

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
  const db = await startRealPostgres();
  await db.prisma.$disconnect();

  process.env[TEST_DATABASE_ENV] = "1";
  process.env.DATABASE_URL = db.url;

  const { checkGrowthPointBalance, deductGrowthPoints, creditGrowthPointsFromPurchase, adjustGrowthPointBalance } =
    await import("@/lib/growthPoints/ledger");
  const { getGrowthPointHistory } = await import("@/lib/growthPoints/ownerQueries");
  const { rewardReferralIfEligible } = await import("@/lib/growthPoints/referral");
  const { setActiveBusiness } = await import("@/lib/businessContext");
  const { prismaSystem: prisma } = await import("@/lib/prisma");

  const makeStore = (userId: string, name: string, slug: string, balance: number) =>
    prisma.store.create({
      data: { userId, name, slug, tagline: "t", description: "d", currency: "USD", growthPointBalance: balance },
    });

  const balanceOf = async (storeId: string) =>
    (await prisma.store.findUniqueOrThrow({ where: { id: storeId }, select: { growthPointBalance: true } }))
      .growthPointBalance;

  const owner = await prisma.user.create({ data: { email: "gp-owner@example.test" } });
  const iron = await makeStore(owner.id, "Iron Gym", "iron-gym", 100);
  const copper = await makeStore(owner.id, "Copper & Coil", "copper-coil", 5);
  // Iron Gym is ACTIVE throughout. Every assertion about Copper & Coil is
  // therefore also an assertion that nothing fell back to the active business.
  await setActiveBusiness(owner.id, iron.id);

  // ==========================================================================
  console.log("\n=== 1. Each business has its own balance ===\n");
  // ==========================================================================
  check("the active business's balance", await balanceOf(iron.id), 100);
  check("and the other one's, which is different", await balanceOf(copper.id), 5);

  const ironGate = await checkGrowthPointBalance(iron.id, "update_hero");
  const copperGate = await checkGrowthPointBalance(copper.id, "update_hero");
  assert("the well-funded business can afford the action", ironGate.ok);
  assert("and the gate quotes ITS balance", ironGate.balance === 100);
  assert("the other one is judged on its own balance", copperGate.balance === 5);

  // ==========================================================================
  console.log("\n=== 2. A deduction lands where it was told, not where it is active ===\n");
  // ==========================================================================
  const log = await prisma.executionLog.create({
    data: {
      executionId: "exec-copper-1",
      storeId: copper.id,
      action: "store.update_hero",
      status: "SUCCESS",
      message: "ok",
      actorType: "USER",
    },
  });
  await deductGrowthPoints({
    storeId: copper.id,
    actionType: "update_hero",
    cost: 2,
    executionLogId: log.id,
  });

  check("the named business paid", await balanceOf(copper.id), 3);
  // THE ASSERTION THIS SUITE EXISTS FOR: the active business paid nothing.
  check("the ACTIVE business was not charged", await balanceOf(iron.id), 100);

  const copperHistory = await getGrowthPointHistory(copper.id);
  const ironHistory = await getGrowthPointHistory(iron.id);
  check("the transaction is on the business that paid", copperHistory.length, 1);
  check("and the other business has no transaction at all", ironHistory.length, 0);

  // ==========================================================================
  console.log("\n=== 3. Running out in one business does not stop the other ===\n");
  // ==========================================================================
  await prisma.store.update({ where: { id: copper.id }, data: { growthPointBalance: 0 } });
  const broke = await checkGrowthPointBalance(copper.id, "update_hero");
  assert("the empty business cannot afford it", !broke.ok);
  const stillFine = await checkGrowthPointBalance(iron.id, "update_hero");
  assert("while the other still can", stillFine.ok, "one business's balance is not the account's");

  // ==========================================================================
  console.log("\n=== 4. A purchase credits the business that bought it ===\n");
  // ==========================================================================
  // What the Stripe webhook does with the storeId it read from session metadata.
  const credited = await creditGrowthPointsFromPurchase({
    storeId: copper.id,
    amount: 250,
    externalRef: "cs_test_copper_1",
    description: "Purchased 250 Growth Points",
  });
  check("the purchase was applied", credited.credited, true);
  check("to the business that paid", await balanceOf(copper.id), 250);
  check("and not to the active one", await balanceOf(iron.id), 100);

  // Stripe retries. The same session must never credit twice.
  const replay = await creditGrowthPointsFromPurchase({
    storeId: copper.id,
    amount: 250,
    externalRef: "cs_test_copper_1",
    description: "Purchased 250 Growth Points",
  });
  check("a webhook replay credits nothing", replay.credited, false);
  check("and the balance is unchanged", await balanceOf(copper.id), 250);

  // NEGATIVE CONTROL: the same payment aimed at the other business is a
  // DIFFERENT external ref, so idempotency must not silently swallow it — and
  // must not move points between businesses either.
  await creditGrowthPointsFromPurchase({
    storeId: iron.id,
    amount: 10,
    externalRef: "cs_test_iron_1",
    description: "Purchased 10 Growth Points",
  });
  check("a separate purchase credits its own business", await balanceOf(iron.id), 110);
  check("leaving the other untouched", await balanceOf(copper.id), 250);

  // ==========================================================================
  console.log("\n=== 5. The referral reward, which used to pick by recency ===\n");
  // ==========================================================================
  const referrer = await prisma.user.create({ data: { email: "gp-referrer@example.test" } });
  const referrerChosen = await makeStore(referrer.id, "Referrer Chosen", "referrer-chosen", 0);
  const referrerOther = await makeStore(referrer.id, "Referrer Other", "referrer-other", 0);
  // The referrer explicitly chose one business. The OTHER is deliberately the
  // most recently updated, which is what the old code would have picked.
  await setActiveBusiness(referrer.id, referrerChosen.id);
  await prisma.store.update({ where: { id: referrerOther.id }, data: { tagline: "touched last" } });

  const plan = await prisma.plan.create({
    data: { id: "gp-plan", name: "Test Plan", priceInCents: 0, monthlyGrowthPointAllowance: 0, referralRewardPoints: 40 },
  });
  await prisma.store.updateMany({
    where: { id: { in: [referrerChosen.id, referrerOther.id, copper.id, iron.id] } },
    data: { planId: plan.id },
  });

  const referred = await prisma.user.create({ data: { email: "gp-referred@example.test" } });
  const referredOnboarded = await makeStore(referred.id, "Referred Onboarded", "referred-onboarded", 0);
  const referredOther = await makeStore(referred.id, "Referred Other", "referred-other", 0);
  await prisma.store.updateMany({
    where: { id: { in: [referredOnboarded.id, referredOther.id] } },
    data: { planId: plan.id },
  });
  // Again the other business is the most recently updated — the old pick.
  await prisma.store.update({ where: { id: referredOther.id }, data: { tagline: "touched last" } });

  await prisma.referral.create({
    data: { referrerUserId: referrer.id, referredUserId: referred.id, code: "REF123", status: "PENDING" },
  });

  // The caller passes the business whose onboarding just completed.
  await rewardReferralIfEligible(referred.id, referredOnboarded.id);

  check("the referred owner's ONBOARDED business was rewarded", await balanceOf(referredOnboarded.id), 40);
  check("not the one that happened to be touched last", await balanceOf(referredOther.id), 0);
  check("the referrer's CHOSEN business was rewarded", await balanceOf(referrerChosen.id), 40);
  check("not their most recently updated one", await balanceOf(referrerOther.id), 0);

  const referralRow = await prisma.referral.findFirstOrThrow({ where: { referredUserId: referred.id } });
  check("and the referral is marked rewarded", referralRow.status, "REWARDED");

  // Running it again pays nothing more.
  await rewardReferralIfEligible(referred.id, referredOnboarded.id);
  check("a second run pays nothing", await balanceOf(referredOnboarded.id), 40);

  // ==========================================================================
  console.log("\n=== 6. An ambiguous referrer is not guessed at ===\n");
  // ==========================================================================
  const vague = await prisma.user.create({ data: { email: "gp-vague@example.test" } });
  const vagueA = await makeStore(vague.id, "Vague A", "vague-a", 0);
  const vagueB = await makeStore(vague.id, "Vague B", "vague-b", 0);
  await prisma.store.updateMany({
    where: { id: { in: [vagueA.id, vagueB.id] } },
    data: { planId: plan.id },
  });
  // Two businesses, nothing saying which. resolveBusiness answers "ambiguous".

  const referred2 = await prisma.user.create({ data: { email: "gp-referred-2@example.test" } });
  const referred2Store = await makeStore(referred2.id, "Referred Two", "referred-two", 0);
  await prisma.store.update({ where: { id: referred2Store.id }, data: { planId: plan.id } });
  await prisma.referral.create({
    data: { referrerUserId: vague.id, referredUserId: referred2.id, code: "REF456", status: "PENDING" },
  });

  await rewardReferralIfEligible(referred2.id, referred2Store.id);

  check("neither of the referrer's businesses was credited",
    [await balanceOf(vagueA.id), await balanceOf(vagueB.id)], [0, 0]);
  // And the reward is not silently thrown away: the referral stays PENDING
  // rather than being flipped to REWARDED without paying.
  check("the referral is left pending rather than falsely rewarded",
    (await prisma.referral.findFirstOrThrow({ where: { referredUserId: referred2.id } })).status,
    "PENDING");
  check("and the referred side was not paid on its own either",
    await balanceOf(referred2Store.id), 0);

  // ==========================================================================
  console.log("\n=== 7. Operator adjustments are per-business too ===\n");
  // ==========================================================================
  await adjustGrowthPointBalance({ storeId: copper.id, amount: 15, adjustedByLabel: "operator" });
  check("the adjusted business changed", await balanceOf(copper.id), 265);
  check("the other did not", await balanceOf(iron.id), 110);

  const finalIron = await getGrowthPointHistory(iron.id);
  const finalCopper = await getGrowthPointHistory(copper.id);
  assert(
    "and no transaction names the other business",
    finalIron.every((t) => t.description !== "Referral reward") &&
      finalCopper.length > finalIron.length
  );

  await prisma.$disconnect();
  await db.close();

  console.log(`\n${failures === 0 ? "All Growth Point assertions passed." : `${failures} assertion(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
