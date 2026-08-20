import { planDeduction } from "@/lib/growthPoints/ledger";

// The Growth Point ledger's debit side. No database, no network:
//
//   npx tsx scripts/verify-growth-point-ledger.ts
//
// Growth Points are sold for real money, so the ledger has four properties
// worth asserting rather than assuming: points are never lost, never
// duplicated, never deducted twice, and never left uncharged silently after a
// successful operation.
//
// The credit side already guarded itself — creditGrowthPointsFromPurchase
// checks a unique externalRef inside its own transaction, so a redelivered
// Stripe event cannot double-credit. The DEBIT side had no such guard, and the
// balance check ran in a different transaction from the decrement.
//
// Sections 1 and 2 carry the pre-fix behaviour and prove both defects were real.

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

// THE OLD IMPLEMENTATION. No idempotency check at all, and an unconditional
// decrement with no floor.
function oldDeduct(balance: number, cost: number): { balanceAfter: number; charged: number } {
  return { balanceAfter: balance - cost, charged: cost };
}

// ---------------------------------------------------------------------------
console.log("\n1. The same execution charged twice");
{
  // Nothing stopped a retried or redelivered deduction from taking the points
  // again — the credit side checked externalRef, the debit side checked nothing.
  const first = oldDeduct(100, 10);
  const second = oldDeduct(first.balanceAfter, 10);
  assert("the old code charged twice for one execution",
    first.charged + second.charged === 20 && second.balanceAfter === 80);

  // The fix: idempotency is decided BEFORE anything else, so a plan or a
  // balance change since the first charge cannot resurrect it.
  check("a second attempt does nothing",
    planDeduction({ alreadyCharged: true, unlimitedSource: null, balance: 90, cost: 10 }),
    { kind: "already_charged" });
  check("not even when the store is now on an unlimited plan",
    planDeduction({ alreadyCharged: true, unlimitedSource: "plan", balance: 90, cost: 10 }),
    { kind: "already_charged" });
  check("not even when the balance would not cover it",
    planDeduction({ alreadyCharged: true, unlimitedSource: null, balance: 0, cost: 10 }),
    { kind: "already_charged" });
}

// ---------------------------------------------------------------------------
console.log("\n2. Spending points the store does not have");
{
  // checkGrowthPointBalance ran in execute() before the work; the decrement ran
  // in a different transaction afterwards. Two concurrent actions could both
  // pass the check and both decrement.
  const balance = 5;
  const a = oldDeduct(balance, 5);
  const b = oldDeduct(a.balanceAfter, 5); // the concurrent one
  assert("the old code drove the balance negative", b.balanceAfter === -5);

  // The fix refuses to charge what is not there, and says so rather than
  // pretending the action was free.
  const plan = planDeduction({ alreadyCharged: false, unlimitedSource: null, balance: 5, cost: 10 });
  check("a shortfall is named, not silently swallowed", plan, {
    kind: "uncharged_shortfall",
    cost: 10,
    balance: 5,
  });
  assert("and it is never a charge", plan.kind !== "charge");
}

// ---------------------------------------------------------------------------
console.log("\n3. A normal, affordable action is charged exactly once");
{
  check("the ordinary case", planDeduction({ alreadyCharged: false, unlimitedSource: null, balance: 100, cost: 10 }), {
    kind: "charge",
    cost: 10,
  });
  // Exactly affordable must still charge — an off-by-one here silently makes
  // every action at the boundary free.
  check("a balance exactly equal to the cost still charges",
    planDeduction({ alreadyCharged: false, unlimitedSource: null, balance: 10, cost: 10 }),
    { kind: "charge", cost: 10 });
  check("one point short does not",
    planDeduction({ alreadyCharged: false, unlimitedSource: null, balance: 9, cost: 10 }),
    { kind: "uncharged_shortfall", cost: 10, balance: 9 });
  // A free action costs nothing and must not be reported as a shortfall.
  check("a zero-cost action is a charge of zero, not a shortfall",
    planDeduction({ alreadyCharged: false, unlimitedSource: null, balance: 0, cost: 0 }),
    { kind: "charge", cost: 0 });
}

// ---------------------------------------------------------------------------
console.log("\n4. Plan and trial coverage never moves the balance");
{
  // A covered action still writes a ledger row — the owner's history stays
  // honest about what happened — but must never decrement.
  for (const source of ["plan", "trial"] as const) {
    check(`${source} coverage`, planDeduction({ alreadyCharged: false, unlimitedSource: source, balance: 100, cost: 10 }), {
      kind: "covered",
      source,
    });
  }
  // Coverage must work at zero balance — that is the entire point of an
  // unlimited plan.
  check("covered at zero balance", planDeduction({ alreadyCharged: false, unlimitedSource: "plan", balance: 0, cost: 50 }), {
    kind: "covered",
    source: "plan",
  });
  assert("coverage is checked before affordability, not after",
    planDeduction({ alreadyCharged: false, unlimitedSource: "trial", balance: 0, cost: 999 }).kind === "covered");
}

// ---------------------------------------------------------------------------
console.log("\n5. Every outcome is one of the four, and points are conserved");
{
  // A plan that fell through to undefined would decrement nothing and record
  // nothing — an action silently free forever.
  const cases = [
    { alreadyCharged: true, unlimitedSource: null, balance: 0, cost: 0 },
    { alreadyCharged: false, unlimitedSource: "plan" as const, balance: 0, cost: 5 },
    { alreadyCharged: false, unlimitedSource: null, balance: 0, cost: 5 },
    { alreadyCharged: false, unlimitedSource: null, balance: 50, cost: 5 },
  ];
  for (const c of cases) {
    const plan = planDeduction(c);
    assert(`${JSON.stringify(c).slice(0, 46)}… resolves`,
      ["already_charged", "covered", "charge", "uncharged_shortfall"].includes(plan.kind), plan.kind);
  }
  // Only ONE outcome ever moves the balance, and only downward by the cost.
  const charging = cases.filter((c) => planDeduction(c).kind === "charge");
  check("exactly one of these charges", charging.length, 1);
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
