import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import Stripe from "stripe";

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

// Business Partner's monthly allowance is deliberately the same as
// Growth (25/mo) — Sean's own call: the premium isn't "more points," it's
// removing friction from routine 1-point actions entirely while the
// normal economy still governs 2/3/5-point strategic actions. Unlimited
// *everything* would defeat the point of the economy representing
// meaningful business investment.
const PLANS: PlanSpec[] = [
  { name: "Builder", priceInCents: 2999, monthlyGrowthPointAllowance: 12, unlimitedActionCostCeiling: null },
  { name: "Growth", priceInCents: 4999, monthlyGrowthPointAllowance: 25, unlimitedActionCostCeiling: null },
  { name: "Business Partner", priceInCents: 9999, monthlyGrowthPointAllowance: 25, unlimitedActionCostCeiling: 1 },
];

interface PackageSpec {
  key: string;
  label: string;
  pointAmount: number;
  priceInCents: number;
}

const PACKAGES: PackageSpec[] = [
  { key: "pack_4", label: "4 Growth Points", pointAmount: 4, priceInCents: 999 },
  { key: "pack_8", label: "8 Growth Points", pointAmount: 8, priceInCents: 1999 },
  { key: "pack_20", label: "20 Growth Points", pointAmount: 20, priceInCents: 4999 },
  { key: "pack_45", label: "45 Growth Points", pointAmount: 45, priceInCents: 9999 },
];

async function main() {
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
