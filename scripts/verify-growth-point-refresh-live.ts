import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";

// THE MONTHLY GROWTH POINT REFRESH — Chapter 5's own correctness closeout:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-growth-point-refresh-live.ts" -OutFile out.txt
//
// A real money path with NO verification coverage until now: nothing in scripts/
// referenced runDueGrowthPointRefreshes at all. It grants Growth Points every
// month, to every store on a plan, unattended, from the cron sweep.
//
// THE PROPERTY THE CANCELLATION HANDLER DEPENDS ON. The Stripe webhook for
// customer.subscription.deleted deliberately does NOT null planId — it sets
// subscriptionStatus to "canceled" and, in its own words, "what actually stops
// further monthly grants is gating the refresh sweep's own due-query on
// subscriptionStatus". That is a claim one file makes about another, and it was
// never tested. If it were wrong, a cancelled subscriber would keep receiving
// free points forever and the only symptom would be a slowly growing balance.
//
// Also held: null subscriptionStatus still qualifies, because a comped or
// hand-assigned plan is a legitimate case rather than a lapsed one — the sweep
// must tell "never had a Stripe subscription" apart from "had one and lost it".

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

  const { getDueGrowthPointRefreshes, runDueGrowthPointRefreshes } = await import(
    "@/lib/growthPoints/refresh"
  );
  const { prismaSystem: prisma } = await import("@/lib/prisma");

  const owner = await prisma.user.create({ data: { email: "refresh-owner@example.test" } });

  const plan = await prisma.plan.create({
    data: { id: "refresh-plan", name: "Growth Plan", priceInCents: 2_900, monthlyGrowthPointAllowance: 60 },
  });
  // A real plan somebody is on, that has no allowance figure yet. The
  // "wired but inert" case.
  const plannedButInert = await prisma.plan.create({
    data: { id: "inert-plan", name: "Unpriced Plan", priceInCents: 0 },
  });

  let n = 0;
  const store = (name: string, data: Record<string, unknown>) =>
    prisma.store.create({
      data: {
        userId: owner.id,
        name,
        slug: `${name.toLowerCase().replace(/[^a-z]+/g, "-")}-${++n}`,
        tagline: "t",
        description: "d",
        currency: "USD",
        growthPointBalance: 0,
        ...data,
      } as never,
    });

  const balanceOf = async (id: string) =>
    (await prisma.store.findUniqueOrThrow({ where: { id }, select: { growthPointBalance: true } }))
      .growthPointBalance;
  const nextRefreshOf = async (id: string) =>
    (await prisma.store.findUniqueOrThrow({ where: { id }, select: { growthPointNextRefreshAt: true } }))
      .growthPointNextRefreshAt;

  const due = daysAgo(1);

  const active = await store("Active", { planId: plan.id, subscriptionStatus: "active", growthPointNextRefreshAt: due });
  const trialing = await store("Trialing", { planId: plan.id, subscriptionStatus: "trialing", growthPointNextRefreshAt: due });
  // THE ONE THE WEBHOOK'S CLAIM RESTS ON.
  const canceled = await store("Canceled", { planId: plan.id, subscriptionStatus: "canceled", growthPointNextRefreshAt: due });
  const pastDue = await store("PastDue", { planId: plan.id, subscriptionStatus: "past_due", growthPointNextRefreshAt: due });
  const unpaid = await store("Unpaid", { planId: plan.id, subscriptionStatus: "unpaid", growthPointNextRefreshAt: due });
  // Comped or hand-assigned: a plan with no Stripe subscription behind it.
  const comped = await store("Comped", { planId: plan.id, subscriptionStatus: null, growthPointNextRefreshAt: due });
  // On a plan, but not due yet.
  const notYet = await store("NotYet", {
    planId: plan.id,
    subscriptionStatus: "active",
    growthPointNextRefreshAt: new Date(Date.now() + 20 * DAY),
  });
  // On no plan at all — every production store today.
  const noPlan = await store("NoPlan", { subscriptionStatus: null, growthPointNextRefreshAt: due });
  // On a plan with no allowance figure.
  const inert = await store("Inert", {
    planId: plannedButInert.id,
    subscriptionStatus: "active",
    growthPointNextRefreshAt: due,
  });
  // Never refreshed before — a null due date must count as due.
  const brandNew = await store("BrandNew", {
    planId: plan.id,
    subscriptionStatus: "active",
    growthPointNextRefreshAt: null,
  });

  // ==========================================================================
  console.log("\n=== 1. Who the sweep considers due ===\n");
  // ==========================================================================
  const dueStores = await getDueGrowthPointRefreshes(50);
  const dueIds = new Set(dueStores.map((s) => s.id));

  assert("an active subscription is due", dueIds.has(active.id));
  assert("a trialing one is due", dueIds.has(trialing.id));
  assert("a comped plan with no Stripe status is due", dueIds.has(comped.id), "never had a subscription is not lapsed");
  assert("a store that has never refreshed is due", dueIds.has(brandNew.id), "a null date is due, not skipped forever");

  // THE ASSERTION THE CANCELLATION HANDLER'S COMMENT DEPENDS ON.
  assert("a CANCELED subscription is not due", !dueIds.has(canceled.id), "the gate the webhook relies on");
  assert("nor is past_due", !dueIds.has(pastDue.id));
  assert("nor unpaid", !dueIds.has(unpaid.id));
  assert("a store not yet due is not due", !dueIds.has(notYet.id));
  assert("a store on no plan never appears", !dueIds.has(noPlan.id), "every production store today");

  // ==========================================================================
  console.log("\n=== 2. What the sweep actually grants ===\n");
  // ==========================================================================
  const summaries = await runDueGrowthPointRefreshes(50);
  const granted = new Map(summaries.map((s) => [s.storeId, s.granted]));

  check("the active store was granted its allowance", await balanceOf(active.id), 60);
  check("and it is reported", granted.get(active.id), 60);
  check("the trialing store too", await balanceOf(trialing.id), 60);
  check("and the comped one", await balanceOf(comped.id), 60);
  check("and the never-refreshed one", await balanceOf(brandNew.id), 60);

  // The money assertions, stated as refusals.
  check("the CANCELED store was granted nothing", await balanceOf(canceled.id), 0);
  check("past_due nothing", await balanceOf(pastDue.id), 0);
  check("unpaid nothing", await balanceOf(unpaid.id), 0);
  check("not-yet-due nothing", await balanceOf(notYet.id), 0);
  check("no-plan nothing", await balanceOf(noPlan.id), 0);

  // ==========================================================================
  console.log("\n=== 3. A plan with no allowance advances but grants nothing ===\n");
  // ==========================================================================
  check("nothing was granted", await balanceOf(inert.id), 0);
  assert("but its due date moved forward", (await nextRefreshOf(inert.id))!.getTime() > due.getTime(),
    "otherwise it is re-checked every cycle forever");
  assert("and it produced no summary", !granted.has(inert.id));

  // ==========================================================================
  console.log("\n=== 4. Every grant is a real, recorded transaction ===\n");
  // ==========================================================================
  const tx = await prisma.growthPointTransaction.findMany({
    where: { storeId: active.id },
    select: { type: true, amount: true, balanceAfter: true, description: true },
  });
  check("one transaction", tx.length, 1);
  check("of the refresh kind", tx[0].type, "REFRESH");
  check("for the allowance", tx[0].amount, 60);
  check("carrying the balance it produced", tx[0].balanceAfter, 60);
  assert("and naming the plan", tx[0].description.includes("Growth Plan"));

  check("the canceled store has no transaction at all",
    await prisma.growthPointTransaction.count({ where: { storeId: canceled.id } }), 0);

  // ==========================================================================
  console.log("\n=== 5. Running it again does not grant twice ===\n");
  // ==========================================================================
  // The due date moved a calendar month forward, so a second sweep in the same
  // minute must find nothing. This is what makes the cron safe to re-trigger.
  const secondRun = await runDueGrowthPointRefreshes(50);
  check("a second sweep grants nothing", secondRun.length, 0);
  check("and the balance is unchanged", await balanceOf(active.id), 60);
  check("still one transaction", await prisma.growthPointTransaction.count({ where: { storeId: active.id } }), 1);

  const advanced = await nextRefreshOf(active.id);
  assert("the next refresh is about a month out", advanced!.getTime() > Date.now() + 20 * DAY);

  // ==========================================================================
  console.log("\n=== 6. One owner, two businesses, refreshed independently ===\n");
  // ==========================================================================
  // Both belong to the same account. Growth Points are per-business, so each
  // must be granted on its own plan and its own schedule.
  const first = await store("PairOne", { planId: plan.id, subscriptionStatus: "active", growthPointNextRefreshAt: due });
  const second = await store("PairTwo", { planId: plan.id, subscriptionStatus: "canceled", growthPointNextRefreshAt: due });

  await runDueGrowthPointRefreshes(50);
  check("the subscribed business was granted", await balanceOf(first.id), 60);
  check("the cancelled one was not, in the same account", await balanceOf(second.id), 0);
  assert(
    "so a plan is a property of a business, not of the account",
    (await balanceOf(first.id)) !== (await balanceOf(second.id))
  );

  await prisma.$disconnect();
  await db.close();

  console.log(`\n${failures === 0 ? "All refresh assertions passed." : `${failures} assertion(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
