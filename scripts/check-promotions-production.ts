import { existsSync } from "fs";
import * as dotenv from "dotenv";

// DID THE TWO MIGRATIONS LAND, AND DID THEY DISTURB ANYTHING:
//
//   npx tsx scripts/check-promotions-production.ts path/to/production.env
//
// STRICTLY READ-ONLY. Every statement below is a SELECT. Nothing is created,
// updated or deleted, so this is safe to run against production repeatedly —
// same shape and same env-file argument as check-bi-production-readiness.ts, so
// a live connection string never goes through shell history.
//
// WHY THIS EXISTS. `migrate deploy` reporting success proves the SQL executed.
// It does not prove the columns are the shape the application expects, that the
// constraints are enforcing anything, or — the question that actually matters
// after an additive migration — that not one existing row changed.
//
// NOTHING HERE INTERPRETS. Every number is counted, and a zero is reported as a
// zero rather than as an absence.

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
  console.log("No env file named — using the ambient environment.\n");
  console.log("This is almost certainly your DEV database. Pass a production");
  console.log("env file as the first argument to ask production.\n");
}

let problems = 0;
function ok(name: string, good: boolean, detail = ""): void {
  if (!good) problems++;
  console.log(`${good ? "  OK  " : " MISS "} ${name}${detail ? `  — ${detail}` : ""}`);
}

async function main() {
  const { prismaSystem: prisma } = await import("@/lib/prisma");

  const host = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/\/.*$/, "");
  console.log("=".repeat(66));
  console.log(`DATABASE: ${host || "(unknown)"}`);
  console.log("=".repeat(66));

  // --- 1. The tables and columns the migrations were supposed to create ----
  console.log("\n1. DID THE SCHEMA CHANGES LAND\n");

  const tables = await prisma.$queryRaw<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name IN ('Promotion', 'PromotionProduct')
    ORDER BY table_name`;
  const tableNames = tables.map((t) => t.table_name);
  ok("Promotion table exists", tableNames.includes("Promotion"));
  ok("PromotionProduct table exists", tableNames.includes("PromotionProduct"));

  const orderColumns = await prisma.$queryRaw<{ column_name: string; data_type: string; is_nullable: string }[]>`
    SELECT column_name, data_type, is_nullable FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'Order'
      AND column_name IN (
        'listSubtotalInCents','discountInCents','appliedPromotionId','appliedPromotionLabel',
        'appliedPromotionCode','appliedPromotionKind',
        'parcelWeightOz','parcelLengthIn','parcelWidthIn','parcelHeightIn'
      )
    ORDER BY column_name`;
  const byName = new Map(orderColumns.map((c) => [c.column_name, c]));
  for (const column of [
    "listSubtotalInCents", "discountInCents", "appliedPromotionId", "appliedPromotionLabel",
    "appliedPromotionCode", "appliedPromotionKind",
    "parcelWeightOz", "parcelLengthIn", "parcelWidthIn", "parcelHeightIn",
  ]) {
    const found = byName.get(column);
    // NULLABLE IS THE ASSERTION, not merely present: a NOT NULL column added to
    // a table with rows in it would have failed the migration, and one that
    // somehow arrived NOT NULL would break every future order write.
    ok(`Order.${column}`, found?.is_nullable === "YES", found ? `${found.data_type}, nullable` : "absent");
  }

  const productColumns = await prisma.$queryRaw<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'Product'
      AND column_name IN ('weightOz','lengthIn','widthIn','heightIn','sourceKind','fulfillmentProvider')`;
  ok("the four packaging columns and both sourcing columns are on Product",
    productColumns.length === 6, `${productColumns.length} of 6`);

  // --- 2. Are the constraints actually enforcing ---------------------------
  console.log("\n2. ARE THE GUARDS REAL\n");

  const checks = await prisma.$queryRaw<{ conname: string }[]>`
    SELECT conname FROM pg_constraint
    WHERE conrelid = '"Promotion"'::regclass AND contype = 'c'
    ORDER BY conname`;
  const checkNames = checks.map((c) => c.conname);
  ok("a promotion must say how much it takes off",
    checkNames.includes("Promotion_discount_value_present"));
  ok("a code belongs to a CODE and never a SALE",
    checkNames.includes("Promotion_code_matches_kind"));
  ok("a window cannot close before it opens",
    checkNames.includes("Promotion_window_ordered"));

  // confdeltype is a Postgres "char", which the driver cannot deserialize —
  // cast to text so this reads the value rather than failing on its type.
  const fk = await prisma.$queryRaw<{ conname: string; confdeltype: string }[]>`
    SELECT conname, confdeltype::text AS confdeltype FROM pg_constraint
    WHERE conrelid = '"Order"'::regclass AND contype = 'f' AND conname = 'Order_appliedPromotionId_fkey'`;
  // 'n' is SET NULL. Deleting a promotion must never delete or blank the record
  // of what somebody actually paid.
  ok("deleting a promotion sets the order's link null rather than cascading",
    fk[0]?.confdeltype === "n", fk[0] ? `confdeltype=${fk[0].confdeltype}` : "no such constraint");

  const uniqueCode = await prisma.$queryRaw<{ indexname: string }[]>`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'Promotion'
      AND indexname = 'Promotion_storeId_code_key'`;
  ok("one code per business", uniqueCode.length === 1);

  // --- 3. Did anything that already existed change ------------------------
  console.log("\n3. WAS ANY EXISTING ROW DISTURBED\n");

  const [orders] = await prisma.$queryRaw<{ total: bigint; discounted: bigint; parcelled: bigint }[]>`
    SELECT
      count(*) AS total,
      count(*) FILTER (WHERE "discountInCents" IS NOT NULL) AS discounted,
      count(*) FILTER (WHERE "parcelWeightOz" IS NOT NULL) AS parcelled
    FROM "Order"`;
  console.log(`  ${orders.total} order(s) in production`);
  ok("no existing order carries a discount",
    Number(orders.discounted) === 0, `${orders.discounted} do`);
  ok("no existing order carries a shipped parcel",
    Number(orders.parcelled) === 0, `${orders.parcelled} do`);

  const [promos] = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "Promotion"`;
  ok("no promotions exist yet, which is correct for a just-deployed feature",
    Number(promos.n) === 0, `${promos.n} found`);

  // --- 4. What the new behaviour will do to real products ------------------
  console.log("\n4. WHAT THIS CHANGES FOR REAL PRODUCTS\n");

  const kinds = await prisma.$queryRaw<{ sourceKind: string | null; n: bigint }[]>`
    SELECT "sourceKind"::text AS "sourceKind", count(*) AS n
    FROM "Product" WHERE "active" = true
    GROUP BY "sourceKind" ORDER BY n DESC`;
  console.log("  active products by who ships them:");
  for (const row of kinds) {
    const partner = row.sourceKind === "PRINT_ON_DEMAND" || row.sourceKind === "WHOLESALE_DROPSHIP";
    const nobody = row.sourceKind === "DIGITAL";
    const who = nobody ? "nobody ships" : partner ? "PARTNER ships" : "owner ships";
    console.log(`    ${String(row.n).padStart(4)}  ${row.sourceKind ?? "(none recorded)"}  ->  ${who}`);
  }

  const [weights] = await prisma.$queryRaw<{ total: bigint; weighed: bigint; boxed: bigint }[]>`
    SELECT
      count(*) AS total,
      count(*) FILTER (WHERE "weightOz" IS NOT NULL AND "weightOz" > 0) AS weighed,
      count(*) FILTER (WHERE "lengthIn" IS NOT NULL AND "widthIn" IS NOT NULL AND "heightIn" IS NOT NULL) AS boxed
    FROM "Product" WHERE "active" = true`;
  console.log(`\n  ${weights.weighed} of ${weights.total} active products have a packaged weight`);
  console.log(`  ${weights.boxed} of ${weights.total} have all three package dimensions`);

  // The gate the storefront reads. A store with no connected EasyPost cannot
  // quote live shipping regardless of what its products weigh.
  const easypost = await prisma.$queryRaw<{ status: string; n: bigint }[]>`
    SELECT "status"::text AS status, count(*) AS n
    FROM "StoreIntegration" WHERE "provider" = 'EASYPOST' GROUP BY "status"`;
  console.log(`\n  EasyPost connections: ${easypost.length === 0 ? "none in any business" :
    easypost.map((r) => `${r.n} ${r.status}`).join(", ")}`);

  const [stripe] = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM "StoreIntegration"
    WHERE "provider" = 'STRIPE' AND "status" = 'CONNECTED'`;
  console.log(`  Stripe connected in ${stripe.n} business(es)`);

  console.log("\n" + "=".repeat(66));
  console.log(problems === 0
    ? "MIGRATIONS LANDED, NOTHING EXISTING DISTURBED."
    : `${problems} problem(s) above.`);
  console.log("=".repeat(66));
  process.exit(problems === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
