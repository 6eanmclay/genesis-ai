import { growthPointPackage, growthPointPackages } from "@/lib/growthPoints/purchaseCatalog";
import { PLANS, PACKAGES } from "@/scripts/provision-pricing";

// WHAT AN OWNER IS CHARGED, AND WHY A PLAN IS STILL WORTH IT:
//
//   npx tsx scripts/verify-purchase-catalog.ts
//
// The Growth Point packs are the one place in Genesis where a lookup's return
// value goes straight to a live Stripe checkout. Nothing covered it.
//
// THE DEFECT THIS FOUND, and the reason it is worse here than anywhere else the
// same shape has turned up: growthPointPackage did a bare Record lookup, so
// `growthPointPackage("constructor")` resolved to the inherited Object
// constructor. It is truthy, so it passed `pkg &&`. Its `stripePriceId` is
// `undefined`, which is `!== null`, so it passed the second guard too. The
// function was returned AS A PACKAGE, and createGrowthPointCheckout handed
// `price: undefined` to checkout.sessions.create.
//
// THE ECONOMIC INVARIANT is the other half, and it is Sean's product decision
// rather than an implementation detail: the packs are "deliberately priced
// slightly above the equivalent per-point subscription rate so a one-off pack
// never quietly out-values committing to a plan." The file even names the
// consequence of breaking it — "repricing a pack below $2.22/pt would break
// that and needs the plan ladder re-checked alongside it." That is a rule with
// a stated tripwire and nothing watching it.
//
// And the pack list exists TWICE: here and in provision-pricing.ts, which is
// what actually creates the Stripe Prices. A ninth mirrored registry, on a
// money path — drift means the price an owner is shown is not the price Stripe
// charges. See ARCHITECTURE.md, "Standing invariant: the mirrored registry".

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

const centsPerPoint = (priceInCents: number, points: number) => priceInCents / points;
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

// ============================================================================
console.log("\n=== 1. Nothing reaches Stripe that is not a real package ===\n");
// ============================================================================
const real = growthPointPackages();
assert("there are packages on offer", real.length > 0, `${real.length}`);
assert("and a known key resolves", growthPointPackage(real[0][0]) !== null, real[0][0]);

check("an unknown key is null", growthPointPackage("pack_9999"), null);
check("an empty key is null", growthPointPackage(""), null);

// THE DEFECT. Each of these resolved to an inherited function, passed both
// guards, and was returned as a package whose stripePriceId was undefined.
for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
  check(`"${key}" is not a package`, growthPointPackage(key), null);
}
assert(
  "so a crafted key can never put `price: undefined` into a live checkout",
  ["constructor", "toString", "valueOf"].every((k) => growthPointPackage(k) === null),
  "createGrowthPointCheckout passes pkg.stripePriceId straight to checkout.sessions.create"
);

// Every package that IS returned carries a chargeable price, not merely a
// non-null one — which was the real requirement all along.
for (const [key, pkg] of real) {
  assert(`${key} has a chargeable Stripe price`,
    typeof pkg.stripePriceId === "string" && pkg.stripePriceId.startsWith("price_"),
    String(pkg.stripePriceId));
  assert(`${key} grants a real number of points`, Number.isInteger(pkg.pointAmount) && pkg.pointAmount > 0,
    String(pkg.pointAmount));
  assert(`${key} costs a real amount`, typeof pkg.priceInCents === "number" && pkg.priceInCents > 0,
    String(pkg.priceInCents));
}

// ============================================================================
console.log("\n=== 2. A pack never out-values committing to a plan ===\n");
// ============================================================================
// The property that makes the subscription ladder rational. Asserted against
// the two tiers the catalogue's own comment names — Business Partner is
// deliberately excluded because its unlimitedActionCostCeiling makes a
// per-point rate the wrong way to compare it.
const laddered = PLANS.filter(
  (p): p is typeof p & { monthlyGrowthPointAllowance: number } =>
    p.unlimitedActionCostCeiling === null && typeof p.monthlyGrowthPointAllowance === "number"
);
assert("there are plans with a comparable per-point rate", laddered.length >= 2,
  JSON.stringify(laddered.map((p) => p.name)));

const bestPlanRate = Math.min(
  ...laddered.map((p) => centsPerPoint(p.priceInCents, p.monthlyGrowthPointAllowance))
);
const worstPlanRate = Math.max(
  ...laddered.map((p) => centsPerPoint(p.priceInCents, p.monthlyGrowthPointAllowance))
);
const bestPackRate = Math.min(...PACKAGES.map((p) => centsPerPoint(p.priceInCents, p.pointAmount)));

assert(
  `the cheapest pack (${money(bestPackRate)}/pt) is dearer than the dearest laddered plan (${money(worstPlanRate)}/pt)`,
  bestPackRate > worstPlanRate,
  "priced slightly above the subscription rate so a one-off pack never quietly out-values a plan"
);
assert(`and far dearer than the best plan rate (${money(bestPlanRate)}/pt)`, bestPackRate > bestPlanRate);

// The stated tripwire, pinned as the number it actually is.
assert(`no pack is priced below $2.22/pt (best is ${money(bestPackRate)})`,
  bestPackRate >= 222,
  "repricing below this needs the plan ladder re-checked alongside it");

// ============================================================================
console.log("\n=== 3. A bigger pack is never worse value ===\n");
// ============================================================================
// Nobody should be punished for buying more. Not stated in the file, but it is
// the assumption every tiered price list makes, and a typo is exactly how it
// breaks.
//
// WITH A ONE-CENT TOLERANCE, and that is a correction rather than a loophole.
// The first version of this compared rates exactly and failed: 999/4 = 249.75¢,
// 1999/8 = 249.875¢, 4999/20 = 249.95¢. Each pack is a hair worse per point
// than the last — but only because the prices end in .99, and the catalogue's
// own comment treats all three as the same rate ("$2.50, or $2.22 on the
// 45-pack"). Sub-cent drift from round price endings is not a value regression;
// asserting on it would have been the suite mistaking its own arithmetic for a
// finding.
const TOLERANCE_CENTS_PER_POINT = 1;
const bySize = [...PACKAGES].sort((a, b) => a.pointAmount - b.pointAmount);
const regressions = bySize
  .map((pkg, i) => ({ pkg, prev: bySize[i - 1] }))
  .filter(
    ({ pkg, prev }) =>
      prev &&
      centsPerPoint(pkg.priceInCents, pkg.pointAmount) >
        centsPerPoint(prev.priceInCents, prev.pointAmount) + TOLERANCE_CENTS_PER_POINT
  )
  .map(({ pkg, prev }) => `${prev.key} → ${pkg.key}`);
check("per-point value never meaningfully gets worse as the pack grows", regressions, []);

// And the discount that IS real is asserted as real, so the tolerance above can
// never quietly swallow the whole tiering.
const smallest = centsPerPoint(bySize[0].priceInCents, bySize[0].pointAmount);
const largest = centsPerPoint(bySize[bySize.length - 1].priceInCents, bySize[bySize.length - 1].pointAmount);
assert(
  `the largest pack is genuinely cheaper per point (${money(largest)} vs ${money(smallest)})`,
  largest < smallest - TOLERANCE_CENTS_PER_POINT,
  "a ladder whose top rung saves nothing is not a ladder"
);

check("and every pack is a distinct size", new Set(PACKAGES.map((p) => p.pointAmount)).size, PACKAGES.length);
check("with a distinct price", new Set(PACKAGES.map((p) => p.priceInCents)).size, PACKAGES.length);

// ============================================================================
console.log("\n=== 4. The shown price is the charged price ===\n");
// ============================================================================
// The mirror. provision-pricing.ts creates the Stripe Prices; purchaseCatalog
// is what the owner sees. Drift means the price on screen is not the price
// Stripe takes.
const offeredKeys = real.map(([key]) => key).sort();
const provisionedKeys = PACKAGES.map((p) => p.key).sort();
check("every offered package was provisioned", offeredKeys.filter((k) => !provisionedKeys.includes(k)), []);
check("and every provisioned package is offered", provisionedKeys.filter((k) => !offeredKeys.includes(k)), []);

for (const spec of PACKAGES) {
  const pkg = growthPointPackage(spec.key);
  assert(`${spec.key} is offered`, pkg !== null);
  if (!pkg) continue;
  check(`${spec.key} shows the price it was provisioned at`, pkg.priceInCents, spec.priceInCents);
  check(`${spec.key} grants the points it was provisioned for`, pkg.pointAmount, spec.pointAmount);
  check(`${spec.key} is labelled the same in both`, pkg.label, spec.label);
}

// A label that disagrees with its own point amount would be its own small lie.
for (const [key, pkg] of real) {
  assert(`${key}'s label states its real point amount`,
    pkg.label.includes(String(pkg.pointAmount)),
    pkg.label);
}

console.log(`\n${failures === 0 ? "All purchase-catalog assertions passed." : `${failures} assertion(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
