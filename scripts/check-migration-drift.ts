import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { execFile } from "child_process";

// DO THE HAND-WRITTEN MIGRATIONS BUILD THE SCHEMA PRISMA THINKS THEY DID:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/check-promotion-migration.ts" -OutFile out.txt
//
// Migrations in this repo are hand-authored, so nothing otherwise guarantees
// that migration.sql and schema.prisma agree. `migrate deploy` succeeding only
// proves the SQL is valid Postgres — a column with the wrong type, a missing
// index or a forgotten default would deploy cleanly and then fail at runtime,
// in production, on a real order.
//
// This applies the real migration files to a real Postgres and asks Prisma to
// diff the result against the datamodel. An empty diff is the whole assertion.
// It earned its keep immediately: the promotions migration created an index on
// Order.appliedPromotionId that schema.prisma did not declare, which nothing
// else in the repo would ever have noticed.

// KNOWN AND PRE-EXISTING, each named individually rather than filtered by a
// pattern loose enough to hide a real one. Printed, never silently dropped — a
// check that quietly swallows drift is how drift survives.
//
// Two are genuine repo-wide drift that predates promotions; the third is the
// test harness's own marker table, which exists only in a throwaway database
// and is not drift at all.
const KNOWN_PRE_EXISTING: { pattern: RegExp; why: string }[] = [
  {
    pattern: /DROP INDEX "User_activeStoreId_idx"/,
    why: "pre-existing drift: the index is in the database but not declared on User",
  },
  {
    pattern: /DROP TABLE "_genesis_test_database"/,
    why: "not drift: the test harness's own marker table",
  },
  {
    pattern: /ALTER INDEX "SupplierEconomics_[^"]*" RENAME TO "SupplierEconomics_[^"]*"/,
    why: "pre-existing drift: Postgres truncated the generated index name differently",
  },
];

async function main() {
  const db = await startRealPostgres();
  await db.prisma.$disconnect();

  const diff = await new Promise<string>((resolve, reject) => {
    execFile(
      process.execPath,
      [
        "node_modules/prisma/build/index.js",
        "migrate",
        "diff",
        // The database as the REAL migration files just built it, against the
        // datamodel Prisma believes in. Prisma 7 removed --from-url, so the
        // live end comes through the config datasource, which reads
        // DATABASE_URL — set below to the throwaway Postgres.
        "--from-config-datasource",
        "--to-schema",
        "prisma/schema.prisma",
        "--script",
      ],
      { env: { ...process.env, DATABASE_URL: db.url } },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`${stdout}\n${stderr}`));
        else resolve(stdout);
      }
    );
  });

  await db.close();

  // Split on the comment header Prisma puts above each statement, so a
  // multi-line ALTER stays whole rather than being judged a line at a time.
  const statements = diff
    .split(/\n(?=--\s)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^--\s*This is an empty migration/.test(s));

  const unexplained: string[] = [];
  for (const statement of statements) {
    const known = KNOWN_PRE_EXISTING.find((k) => k.pattern.test(statement));
    if (known) console.log(`SKIP  ${statement.split("\n").pop()}  -- ${known.why}`);
    else unexplained.push(statement);
  }

  if (unexplained.length === 0) {
    console.log("\nPASS  the migration files build exactly the schema in schema.prisma");
    process.exit(0);
  }

  console.log(`\nFAIL  ${unexplained.length} statement(s) of real drift:\n`);
  console.log(unexplained.join("\n\n"));
  process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
