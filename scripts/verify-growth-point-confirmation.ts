import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import {
  growthPointDecision,
  rememberSkipGrowthPointConfirmation,
  resumeGrowthPointConfirmation,
  spendSummary,
} from "@/lib/growthPoints/confirmation";

// WHEN GENESIS ASKS ABOUT GROWTH POINTS:
//
//   npx tsx scripts/run-db-suites.ts growth-point-confirmation
//
// ============ THE RULE THIS ENFORCES (2026-08-28) =======================
//
// Sean, as a global rule: "Growth Point costs should never be presented during
// the workflow. The cost is disclosed only at the final commitment point...
// Include 'Don't ask me about Growth Points again'... Always override the
// preference if the cost materially changes, the user lacks sufficient Growth
// Points, or another explicit confirmation is required."
//
// The three overrides are the whole reason this is one function rather than a
// habit each feature picks up. A preference that cannot be overridden turns
// into a surprise charge; one that is overridden too eagerly turns into the
// nagging it was meant to stop. Both failures are silent, so both are tested.

let failures = 0;
function assert(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(name, ok, ok ? "" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function main() {
  await requireTestDatabase(prismaSystem);

  const user = await prisma.user.create({
    data: { email: "gp-confirm@example.test", name: "Owner" },
  });
  const store = await prisma.store.create({
    data: {
      userId: user.id,
      name: "GP Store",
      slug: "gp-confirm-store",
      tagline: "t",
      description: "d",
      growthPointBalance: 24,
    },
  });

  const ask = (over: { alwaysAsk?: boolean } = {}) =>
    growthPointDecision({
      storeId: store.id,
      userId: user.id,
      actionType: "create_product_from_design",
      ...over,
    });

  // ======================================================================
  console.log("\n=== 1. A first-time owner is asked ===\n");
  // ======================================================================

  const first = await ask();
  assert("the question is put", first.mustAsk);
  eq("because they have never been asked", first.reason, "never-asked");
  eq("with the real cost", first.cost, 2);
  eq("and the real balance", first.balance, 24);
  assert("which covers it", first.affordable);

  // ======================================================================
  console.log("\n=== 2. An unmetered action asks nothing ===\n");
  // ======================================================================
  //
  // Saving a design is free and must never produce a Growth Point question.
  // The catalogue is what decides; this reads it rather than keeping a list.

  const free = await growthPointDecision({
    storeId: store.id,
    userId: user.id,
    // Bookkeeping, deliberately unpriced in the catalogue.
    actionType: "communicate_finding",
  });
  eq("a free action costs nothing", free.cost, 0);
  assert("CONTROL: and is not confirmed", !free.mustAsk);
  eq("and says why", free.reason, "not-metered");

  // ======================================================================
  console.log("\n=== 3. Once they opt out, they are left alone ===\n");
  // ======================================================================

  await rememberSkipGrowthPointConfirmation(user.id, 2);
  const quiet = await ask();
  assert("the question stops", !quiet.mustAsk);
  eq("because they asked it to", quiet.reason, "preference-set");
  eq("CONTROL: while the cost is still known", quiet.cost, 2);
  eq("and the balance still read", quiet.balance, 24);

  // ======================================================================
  console.log("\n=== 3b. And the permission does not shrink underneath them ===\n");
  // ======================================================================
  //
  // The recording said it kept "the highest cost they have waved through"
  // and did not: it wrote `Math.max(cost, 0)`, which ignores what is already
  // stored. An action CHEAPER than the agreed cost never asks, so the
  // ordinary route cannot reach this. Two overrides above that comparison
  // can - `alwaysAsk`, and a balance too low to afford even a cheap action -
  // and waving one of those through quietly narrowed the permission.
  await rememberSkipGrowthPointConfirmation(user.id, 5);
  await rememberSkipGrowthPointConfirmation(user.id, 1);
  const after = await prisma.user.findUnique({
    where: { id: user.id },
    select: { growthPointConfirmSkippedCost: true },
  });
  eq("waving through a cheap one keeps the dearer permission",
    after?.growthPointConfirmSkippedCost, 5);

  // And the consequence the owner would actually feel.
  const stillQuiet = await ask();
  assert("so a 2-point action still does not ask", !stillQuiet.mustAsk);
  eq("for the reason they set", stillQuiet.reason, "preference-set");

  await prisma.user.update({
    where: { id: user.id },
    data: { growthPointConfirmSkippedCost: 2 },
  });

  // ======================================================================
  console.log("\n=== 4. OVERRIDE: the cost went up ===\n");
  // ======================================================================
  //
  // "Always override the preference if the cost materially changes." Waving
  // through a 2-point action does not authorise a dearer one.

  await prisma.user.update({
    where: { id: user.id },
    data: { growthPointConfirmSkippedCost: 1 },
  });
  const dearer = await ask();
  assert("a costlier action asks again", dearer.mustAsk);
  eq("and says that is why", dearer.reason, "cost-increased");

  await prisma.user.update({
    where: { id: user.id },
    data: { growthPointConfirmSkippedCost: 5 },
  });
  assert("CONTROL: while a cheaper one still does not",
    !(await ask()).mustAsk,
    "the preference covers what they agreed to and anything less");

  // ======================================================================
  console.log("\n=== 5. OVERRIDE: they cannot afford it ===\n");
  // ======================================================================
  //
  // Not a confirmation so much as news, and it has to reach them before
  // anything runs rather than as a failure afterwards.

  await prisma.store.update({ where: { id: store.id }, data: { growthPointBalance: 1 } });
  const broke = await ask();
  assert("an owner who cannot cover it is told", broke.mustAsk);
  eq("and why", broke.reason, "insufficient-balance");
  assert("CONTROL: and it is marked unaffordable", !broke.affordable);

  await prisma.store.update({ where: { id: store.id }, data: { growthPointBalance: 24 } });

  // ======================================================================
  console.log("\n=== 6. OVERRIDE: the caller insists ===\n");
  // ======================================================================

  const insisted = await ask({ alwaysAsk: true });
  assert("an action that always asks, always asks", insisted.mustAsk);
  eq("and says so", insisted.reason, "caller-insists");

  // ======================================================================
  console.log("\n=== 7. The preference is reversible ===\n");
  // ======================================================================

  await resumeGrowthPointConfirmation(user.id);
  const again = await ask();
  assert("turning it back on asks again", again.mustAsk);
  eq("as though it had never been set", again.reason, "never-asked");

  // ======================================================================
  console.log("\n=== 8. Skipping the question never hides the accounting ===\n");
  // ======================================================================
  //
  // "The preference means skip recurring cost confirmation, not hide Growth
  // Point accounting."

  eq("what it cost and what is left", spendSummary({ verb: "Posted", cost: 1, remaining: 23 }),
    "Posted ✓ · 1 Growth Point used · 23 remaining");
  eq("pluralised honestly", spendSummary({ verb: "Created", cost: 2, remaining: 22 }),
    "Created ✓ · 2 Growth Points used · 22 remaining");
  eq("CONTROL: and an action that cost nothing does not claim a spend",
    spendSummary({ verb: "Saved", cost: 0, remaining: 24 }), "Saved ✓");

  // ---- clean up -------------------------------------------------------
  await prisma.store.delete({ where: { id: store.id } });
  await prisma.user.delete({ where: { id: user.id } });

  await prisma.$disconnect();
  await prismaSystem.$disconnect();

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
