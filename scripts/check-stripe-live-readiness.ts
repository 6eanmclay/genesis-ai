import { existsSync } from "node:fs";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import Stripe from "stripe";

// Read-only pre-flight for the live-mode cutover (2026-08-11). Answers the
// three questions that decide whether swapping STRIPE_SECRET_KEY is safe,
// none of which can be answered from the repo alone:
//
//   1. WHICH Stripe account does this key actually belong to, and can it
//      take a charge? (The open `sk_live_51H8a…` mystery — production has
//      held a live key from a non-Genesis account since Aug 2.)
//   2. Do any Stores already carry a stripeCustomerId / stripeSubscriptionId?
//      Those were minted under whatever account was live at the time, and a
//      key swap orphans every one of them — Stripe answers "no such
//      customer" and that owner's billing breaks with no error at write time.
//   3. Do the stored Plan.stripePriceId values exist under THIS key? A Price
//      ID carries no test/live marker in its shape, so the only honest test
//      is to ask Stripe to retrieve each one and see what happens.
//
// Writes nothing, to Stripe or to the database. Safe to run against
// production repeatedly.

// Optional env-file argument, added because the alternative — setting
// DATABASE_URL / STRIPE_SECRET_KEY by hand in a shell — means pasting live
// credentials through a terminal that treats `&` in a Postgres connection
// string as an operator and silently swallows the rest of the line. Naming
// a file instead keeps real secrets out of shell history and out of any
// transcript. `override: true` because these values are deliberately meant
// to WIN over the dev `.env`, which is the whole point of pointing this at
// a production snapshot.
const envFile = process.argv[2];
if (envFile) {
  if (!existsSync(envFile)) {
    console.error(`No such env file: ${envFile}`);
    process.exit(1);
  }
  const parsed = dotenv.config({ path: envFile, override: true }).parsed ?? {};
  console.log(`Loaded environment from: ${envFile}\n`);
  // Names only, never values. Vercel's Neon and Stripe integrations each
  // set several aliases (POSTGRES_URL, DATABASE_URL_UNPOOLED, ...), so when
  // the expected variable turns out to be a placeholder the real one is
  // often sitting right next to it under a different name.
  const interesting = Object.keys(parsed)
    .filter((k) => /DATABASE|POSTGRES|NEON|STRIPE/i.test(k))
    .sort();
  console.log(`Database/Stripe variable NAMES present (${interesting.length}):`);
  for (const k of interesting) {
    const v = parsed[k] ?? "";
    console.log(`  ${k.padEnd(34)} ${v.length} chars`);
  }
  console.log();
} else {
  dotenv.config();
  console.log("Loaded environment from: .env (default)\n");
}

// Never let a malformed connection string surface as a bare "Invalid URL"
// stack trace — that tells you nothing about WHY, and the one thing you
// must not do to find out is print the string, since it carries the
// database password. Reports only shape: length, scheme, and whether a
// stray newline (the classic result of a wrapped copy-paste) got in.
function describeDbHost(raw: string | undefined): string {
  if (!raw) return "(unset)";
  try {
    return new URL(raw).hostname;
  } catch {
    const scheme = raw.slice(0, Math.max(0, raw.indexOf(":")));
    return `(UNPARSEABLE — ${raw.length} chars, scheme "${scheme || "none"}", contains newline: ${/[\r\n]/.test(raw)}, contains space: ${/\s/.test(raw)})`;
  }
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

async function main() {
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  const mode = key.startsWith("sk_live_") ? "LIVE" : key.startsWith("sk_test_") ? "TEST" : "UNRECOGNIZED/MISSING";
  const dbHost = describeDbHost(process.env.DATABASE_URL);

  console.log("=== Environment this run is pointed at ===");
  console.log(`Stripe key mode:  ${mode}`);
  console.log(`Stripe key head:  ${key ? key.slice(0, 20) + "..." : "(unset)"}`);
  console.log(`Database host:    ${dbHost}\n`);

  // --- 1. Whose account is this, really? ---
  if (key) {
    const stripe = new Stripe(key);
    try {
      // A null id is stripe-node's own supported way to hit GET /v1/account
      // — "describe the account this key belongs to" — which is the entire
      // question being asked here. Passing null rather than an id is the
      // point: the id is what we are trying to learn.
      const acct = await stripe.accounts.retrieve(null);
      console.log("=== Stripe account this key belongs to ===");
      console.log(`Account id:       ${acct.id}`);
      console.log(`Business name:    ${acct.business_profile?.name ?? "(none set)"}`);
      console.log(`Email:            ${acct.email ?? "(none)"}`);
      console.log(`charges_enabled:  ${acct.charges_enabled}`);
      console.log(`payouts_enabled:  ${acct.payouts_enabled}`);
      console.log(`details_submitted:${acct.details_submitted}`);
      if (!acct.charges_enabled) {
        console.log("\n  !! charges_enabled is FALSE — this account cannot take a real payment yet.");
      }
      console.log();
    } catch (err) {
      console.log(`Could not retrieve account: ${(err as Error).message}\n`);
    }
  }

  // --- 2. What would a key swap orphan? ---
  const withCustomer = await prisma.store.count({ where: { stripeCustomerId: { not: null } } });
  const withSubscription = await prisma.store.count({ where: { stripeSubscriptionId: { not: null } } });
  const totalStores = await prisma.store.count();

  // Labelled by the host actually connected to, not "production" — this
  // script is deliberately runnable against local too, and a hardcoded
  // "production" header on local output is exactly the kind of thing that
  // gets misread later.
  console.log(`=== Existing Stripe references in the database at ${dbHost} ===`);
  console.log(`Stores total:                 ${totalStores}`);
  console.log(`Stores w/ stripeCustomerId:   ${withCustomer}`);
  console.log(`Stores w/ stripeSubscriptionId:${withSubscription}`);
  if (withCustomer > 0 || withSubscription > 0) {
    console.log("\n  !! These were created under whatever Stripe account was live when they were made.");
    console.log("     Swapping STRIPE_SECRET_KEY to a different account orphans them.");
  }
  console.log();

  // --- 3. Do the stored Plan Price IDs exist under this key? ---
  // Allowance and ceiling are included because they are the half of a Plan
  // row that Stripe knows nothing about — a Price can verify as live and
  // correct while the points it grants, or the unlimited-action threshold
  // it unlocks, were written wrong and would fail silently at execution
  // time rather than at checkout.
  const plans = await prisma.plan.findMany({
    select: {
      name: true,
      stripePriceId: true,
      priceInCents: true,
      monthlyGrowthPointAllowance: true,
      unlimitedActionCostCeiling: true,
    },
    orderBy: { priceInCents: "asc" },
  });
  console.log("=== Plan rows, checked against THIS key's Stripe mode ===");
  if (plans.length === 0) console.log("(no Plan rows)");

  for (const plan of plans) {
    if (!plan.stripePriceId) {
      console.log(`  ${plan.name.padEnd(18)} (no stripePriceId set)`);
      continue;
    }
    if (!key) {
      console.log(`  ${plan.name.padEnd(18)} ${plan.stripePriceId} (no key set — cannot verify)`);
      continue;
    }
    const stripe = new Stripe(key);
    try {
      const price = await stripe.prices.retrieve(plan.stripePriceId);
      const dollars = (price.unit_amount ?? 0) / 100;
      const gp = plan.monthlyGrowthPointAllowance;
      const perPoint = gp && gp > 0 ? `$${(dollars / gp).toFixed(2)}/pt` : "—";
      console.log(
        `  ${plan.name.padEnd(18)} ${plan.stripePriceId}  EXISTS  livemode=${price.livemode}  $${dollars.toFixed(2)}  ${String(gp ?? "—").padStart(3)}pt  ${perPoint.padEnd(9)} ceiling=${plan.unlimitedActionCostCeiling ?? "none"}`
      );
    } catch {
      console.log(`  ${plan.name.padEnd(18)} ${plan.stripePriceId}  NOT FOUND under this key — needs re-provisioning`);
    }
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
