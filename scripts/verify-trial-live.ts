import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";

// THE BUSINESS PARTNER TRIAL — one per account, unlimited on one business:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-trial-live.ts" -OutFile out.txt
//
// The second Chapter 5 money path with no verification coverage. An active trial
// makes actions UNLIMITED — they execute without spending Growth Points — so
// two things have to hold at once, and they pull in opposite directions:
//
//   ONE PER ACCOUNT     Sean's explicit guard. An owner cannot get seven free
//                       days per business by making more businesses.
//   ONE BUSINESS ONLY   the trial belongs to the store it was granted to. The
//                       account's other business pays normally, or the guard
//                       above would just be a slower way of giving it away.
//
// THE GUARD'S OWN SUBTLETY, documented in trial.ts and never tested: eligibility
// is checked against BusinessPartnerTrialGrant, NOT against Store — so it stays
// correct even if the store that held the earlier trial has since been deleted.
// Checking Store would let an owner delete a trialing business and immediately
// claim another trial.

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

async function main() {
  const db = await startRealPostgres();
  await db.prisma.$disconnect();

  process.env[TEST_DATABASE_ENV] = "1";
  process.env.DATABASE_URL = db.url;

  const { grantBusinessPartnerTrialIfEligible, TRIAL_DURATION_DAYS } = await import(
    "@/lib/growthPoints/trial"
  );
  const { checkGrowthPointBalance } = await import("@/lib/growthPoints/ledger");
  const { prismaSystem: prisma } = await import("@/lib/prisma");

  // The trial's unlimited behaviour is defined by the Business Partner plan's
  // own ceiling — an action costing at or below it runs without spending.
  await prisma.plan.create({
    data: { id: "bp", name: "Business Partner", priceInCents: 9_900, unlimitedActionCostCeiling: 50 },
  });

  let n = 0;
  const makeStore = (userId: string, name: string, balance = 0) =>
    prisma.store.create({
      data: {
        userId,
        name,
        slug: `${name.toLowerCase().replace(/[^a-z]+/g, "-")}-${++n}`,
        tagline: "t",
        description: "d",
        currency: "USD",
        growthPointBalance: balance,
      },
    });

  const trialEndOf = async (id: string) =>
    (await prisma.store.findUniqueOrThrow({ where: { id }, select: { businessPartnerTrialEndsAt: true } }))
      .businessPartnerTrialEndsAt;

  const owner = await prisma.user.create({ data: { email: "trial-owner@example.test" } });
  const first = await makeStore(owner.id, "First Business");
  const second = await makeStore(owner.id, "Second Business");

  // ==========================================================================
  console.log("\n=== 1. The first business gets its trial ===\n");
  // ==========================================================================
  await grantBusinessPartnerTrialIfEligible(owner.id, { id: first.id, name: first.name });

  const ends = await trialEndOf(first.id);
  assert("the trial is on the store", ends !== null);
  assert(
    `it runs about ${TRIAL_DURATION_DAYS} days`,
    Math.round(((ends?.getTime() ?? 0) - Date.now()) / DAY) === TRIAL_DURATION_DAYS
  );
  check("and one grant row records it",
    await prisma.businessPartnerTrialGrant.count({ where: { userId: owner.id } }), 1);

  // ==========================================================================
  console.log("\n=== 2. One per account, not one per business ===\n");
  // ==========================================================================
  await grantBusinessPartnerTrialIfEligible(owner.id, { id: second.id, name: second.name });

  check("the second business gets no trial", await trialEndOf(second.id), null);
  check("and no second grant row exists",
    await prisma.businessPartnerTrialGrant.count({ where: { userId: owner.id } }), 1);
  assert("the first business keeps its own", (await trialEndOf(first.id)) !== null);

  // Idempotent: re-running for the SAME store changes nothing.
  const before = await trialEndOf(first.id);
  await grantBusinessPartnerTrialIfEligible(owner.id, { id: first.id, name: first.name });
  check("re-granting the same store does not extend it", await trialEndOf(first.id), before);
  check("and still one grant row",
    await prisma.businessPartnerTrialGrant.count({ where: { userId: owner.id } }), 1);

  // ==========================================================================
  console.log("\n=== 3. Unlimited on the trialing business only ===\n");
  // ==========================================================================
  // Both businesses have a zero balance. Only one of them can act.
  const trialing = await checkGrowthPointBalance(first.id, "update_hero");
  const paying = await checkGrowthPointBalance(second.id, "update_hero");

  assert("the trialing business can act with no points", trialing.ok, "that is what the trial is");
  assert(
    "the account's OTHER business cannot",
    !paying.ok,
    "otherwise one trial would cover every business the owner makes"
  );

  // ==========================================================================
  console.log("\n=== 4. An expired trial is not a trial ===\n");
  // ==========================================================================
  await prisma.store.update({
    where: { id: first.id },
    data: { businessPartnerTrialEndsAt: new Date(Date.now() - DAY) },
  });
  const expired = await checkGrowthPointBalance(first.id, "update_hero");
  assert("yesterday's trial does not pay for today's action", !expired.ok);

  // ==========================================================================
  console.log("\n=== 5. Deleting the trialing business does not buy another ===\n");
  // ==========================================================================
  // The subtlety trial.ts documents: eligibility is checked against the GRANT
  // row, not against Store. Checking Store would let an owner delete a trialing
  // business and immediately claim a fresh seven days on a new one.
  //
  // Restore the trial to genuinely active first, so the only thing that changes
  // below is the store's existence.
  await prisma.store.update({
    where: { id: first.id },
    data: { businessPartnerTrialEndsAt: new Date(Date.now() + 5 * DAY) },
  });
  await prisma.store.delete({ where: { id: first.id } });

  const third = await makeStore(owner.id, "Third Business");
  await grantBusinessPartnerTrialIfEligible(owner.id, { id: third.id, name: third.name });

  check("a new business gets no trial while the grant is still live", await trialEndOf(third.id), null);
  assert(
    "because eligibility reads the grant, not the store",
    (await prisma.businessPartnerTrialGrant.count({ where: { userId: owner.id } })) === 1,
    "the grant survives the store being deleted"
  );

  // ==========================================================================
  console.log("\n=== 6. A different account is unaffected ===\n");
  // ==========================================================================
  const other = await prisma.user.create({ data: { email: "trial-other@example.test" } });
  const theirs = await makeStore(other.id, "Their Business");
  await grantBusinessPartnerTrialIfEligible(other.id, { id: theirs.id, name: theirs.name });

  assert("another owner still gets their own trial", (await trialEndOf(theirs.id)) !== null);
  check("with their own grant row",
    await prisma.businessPartnerTrialGrant.count({ where: { userId: other.id } }), 1);
  check("and the first account still has exactly one",
    await prisma.businessPartnerTrialGrant.count({ where: { userId: owner.id } }), 1);

  // ==========================================================================
  console.log("\n=== 7. Once the grant lapses, a new one is allowed ===\n");
  // ==========================================================================
  // The guard is "no ACTIVE grant", not "never had one" — a lapsed trial does
  // not bar the account forever, which would be a different product decision
  // than the one recorded.
  await prisma.businessPartnerTrialGrant.updateMany({
    where: { userId: owner.id },
    data: { expiresAt: new Date(Date.now() - DAY) },
  });
  const fourth = await makeStore(owner.id, "Fourth Business");
  await grantBusinessPartnerTrialIfEligible(owner.id, { id: fourth.id, name: fourth.name });

  assert("with no active grant, a new trial is granted", (await trialEndOf(fourth.id)) !== null);
  check("and it is recorded as its own grant",
    await prisma.businessPartnerTrialGrant.count({ where: { userId: owner.id } }), 2);

  await prisma.$disconnect();
  await db.close();

  console.log(`\n${failures === 0 ? "All trial assertions passed." : `${failures} assertion(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
