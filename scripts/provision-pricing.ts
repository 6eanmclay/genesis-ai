import { existsSync } from "node:fs";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import Stripe from "stripe";

// Same named-env-file argument as check-stripe-live-readiness.ts, and for
// the same reason: the live run needs a live key and the production
// DATABASE_URL, and setting those by hand in PowerShell means a Postgres
// connection string's `&` gets parsed as a shell operator. `override: true`
// so the named file beats the dev `.env` — without it the preflight below
// would be the only thing standing between a "successful"-looking run and
// 14 Stripe objects created in the wrong account.
const envFile = process.argv[2];
if (envFile) {
  if (!existsSync(envFile)) {
    console.error(`No such env file: ${envFile}`);
    process.exit(1);
  }
  dotenv.config({ path: envFile, override: true });
  console.log(`Loaded environment from: ${envFile}\n`);
} else {
  dotenv.config();
}

// Growth Points Economy — real initial pricing provisioning, run once
// 2026-08-05 against Stripe's real test-mode sandbox (see
// ARCHITECTURE.md's "Growth Points Economy — initial real pricing"
// section for the frozen numbers this script encodes). Unlike every
// prior "ZZZ_VERIFICATION_ONLY" script this project has used, this
// script's output is real, persisted application data (Plan rows,
// GrowthPointPackage catalog entries) — it is NOT meant to be re-run
// against the same environment, and its created Stripe objects are NOT
// archived afterward. Kept in the repo as the record of how pricing was
// provisioned, and as the template for provisioning live-mode Stripe
// objects once Sean makes that separate, deliberate decision.

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

interface PlanSpec {
  name: string;
  priceInCents: number;
  monthlyGrowthPointAllowance: number | null;
  unlimitedActionCostCeiling: number | null;
}

// Reworked 2026-08-11, before the live-mode provisioning run and while
// production still had ZERO Plan rows and zero subscriptions — the cheapest
// moment this ladder will ever be changeable. What changed and why:
//
//   - Builder ($29.99 / 12pt) REMOVED. At $2.50/pt it was exactly the à la
//     carte pack rate, so subscribing to it bought a commitment and no
//     discount — the one tier strictly dominated by lib/growthPoints/
//     purchaseCatalog.ts, whose own comment promises the opposite.
//   - Starter added at $20 / 10pt = $2.00/pt. Deliberately 10 and not 9:
//     at 9 it would price to $2.22/pt, identical to the 45-pack, and the
//     entry plan must beat every pack rather than tie the best one.
//   - Growth 25pt -> 28pt, holding $49.99 ($1.79/pt), so the per-point rate
//     still improves as you climb.
//   - Business Partner 25pt -> 40pt and its ceiling 1 -> 2.
//
// The ceiling change is the substantive one. Against the real 12-action
// catalog in lib/growthPoints/catalog.ts, a ceiling of 1 made 3 of 12
// actions (25%) free; a ceiling of 2 makes 7 of 12 (58%) free — and, more
// to the point, it pulls in create_product, the action a merchant actually
// repeats while building a catalog. Everything still metered is exactly the
// 3pt strategic and 5pt whole-brand band, which is where the original "the
// normal economy still governs strategic actions" intent wanted the line.
//
// Business Partner remains the worst tier on raw $/pt ($2.50) BY DESIGN —
// its case rests entirely on the unlimited clause, not on point count, and
// a merchant doing only 3pt/5pt work is genuinely better served by Growth.
// That is J4's recommendation engine's job to say out loud, not something
// to paper over by distorting the numbers.
//
// NOT provisioned here: the $5 "Keep Open" tier. It is a real product
// decision (store stays live and selling, no J4, no Growth Points, 6%
// Genesis transaction fee) that needs two mechanisms this codebase does not
// have yet — an application_fee on merchant checkout, which Standard
// Connect's own-access-token charge path cannot express today, and any
// notion of a plan gating features at all, which the Plan model has no
// column for. Provisioning its Price early would create a live $5
// subscription granting FULL Genesis with zero points, which is precisely
// the hole the tier exists to close.
// Exported for verification (2026-08-22): scripts/verify-purchase-catalog.ts
// asserts that every pack's per-point rate is worse than Starter's and Growth's,
// which is the property that makes committing to a plan rational, and that this
// list agrees with lib/growthPoints/purchaseCatalog.ts's own copy.
export const PLANS: PlanSpec[] = [
  { name: "Starter", priceInCents: 2000, monthlyGrowthPointAllowance: 10, unlimitedActionCostCeiling: null },
  { name: "Growth", priceInCents: 4999, monthlyGrowthPointAllowance: 28, unlimitedActionCostCeiling: null },
  { name: "Business Partner", priceInCents: 9999, monthlyGrowthPointAllowance: 40, unlimitedActionCostCeiling: 2 },
];

interface PackageSpec {
  key: string;
  label: string;
  pointAmount: number;
  priceInCents: number;
}

export const PACKAGES: PackageSpec[] = [
  { key: "pack_4", label: "4 Growth Points", pointAmount: 4, priceInCents: 999 },
  { key: "pack_8", label: "8 Growth Points", pointAmount: 8, priceInCents: 1999 },
  { key: "pack_20", label: "20 Growth Points", pointAmount: 20, priceInCents: 4999 },
  { key: "pack_45", label: "45 Growth Points", pointAmount: 45, priceInCents: 9999 },
];

// Live-mode preflight, added 2026-08-11 for the real live provisioning run.
// The failure this prevents is a silent one: this script imports
// "dotenv/config", so if the local .env's own (test-mode, localhost) values
// ever won over the shell-set ones, it would cheerfully create Prices in the
// SANDBOX and write them to the LOCAL database while printing output that
// looks exactly like a successful live run. Refusing up front is the only way
// to tell those two outcomes apart before 14 real Stripe objects exist.
function preflight() {
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  const dbHost = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).hostname : "(unset)";
  const mode = key.startsWith("sk_live_") ? "LIVE" : key.startsWith("sk_test_") ? "TEST" : "UNRECOGNIZED";
  console.log(`Stripe key mode: ${mode}\nDatabase host:   ${dbHost}\n`);

  if (mode !== "LIVE") {
    throw new Error(`Refusing to run: STRIPE_SECRET_KEY is ${mode}, not a live key. The shell value did not take effect.`);
  }
  if (dbHost === "localhost" || dbHost === "127.0.0.1") {
    throw new Error("Refusing to run: DATABASE_URL points at a local database. Live Price IDs must be written to production.");
  }
}

async function main() {
  preflight();
  console.log("Provisioning real Stripe Products/Prices + Plan rows...\n");

  const planResults: { name: string; stripePriceId: string }[] = [];
  for (const plan of PLANS) {
    const product = await stripe.products.create({ name: `Genesis — ${plan.name} Plan` });
    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: plan.priceInCents,
      currency: "usd",
      recurring: { interval: "month" },
    });
    console.log(`Plan "${plan.name}": product=${product.id} price=${price.id} ($${(plan.priceInCents / 100).toFixed(2)}/mo)`);

    await prisma.plan.upsert({
      where: { name: plan.name },
      create: {
        name: plan.name,
        stripePriceId: price.id,
        priceInCents: plan.priceInCents,
        monthlyGrowthPointAllowance: plan.monthlyGrowthPointAllowance,
        unlimitedActionCostCeiling: plan.unlimitedActionCostCeiling,
      },
      update: {
        stripePriceId: price.id,
        priceInCents: plan.priceInCents,
        monthlyGrowthPointAllowance: plan.monthlyGrowthPointAllowance,
        unlimitedActionCostCeiling: plan.unlimitedActionCostCeiling,
      },
    });

    planResults.push({ name: plan.name, stripePriceId: price.id });
  }

  console.log("\nProvisioning real Growth Point package Prices...\n");

  const packageResults: { key: string; stripePriceId: string }[] = [];
  for (const pkg of PACKAGES) {
    const product = await stripe.products.create({ name: `Genesis — Growth Point Pack (${pkg.pointAmount})` });
    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: pkg.priceInCents,
      currency: "usd",
    });
    console.log(`Package "${pkg.key}": product=${product.id} price=${price.id} ($${(pkg.priceInCents / 100).toFixed(2)} -> ${pkg.pointAmount}pt)`);
    packageResults.push({ key: pkg.key, stripePriceId: price.id });
  }

  console.log("\nDone. Update lib/growthPoints/purchaseCatalog.ts's GROWTH_POINT_PURCHASE_CATALOG stripePriceId fields with:\n");
  for (const r of packageResults) {
    console.log(`  ${r.key}: "${r.stripePriceId}"`);
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
