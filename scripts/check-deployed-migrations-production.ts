import { existsSync } from "fs";
import * as dotenv from "dotenv";

// DID THE MIGRATIONS IN THIS PUSH ACTUALLY LAND IN PRODUCTION:
//
//   npx tsx scripts/check-deployed-migrations-production.ts .env.livecheck \
//     20260914180000_approval_task_identity
//
// STRICTLY READ-ONLY. Every statement is a SELECT against _prisma_migrations
// and information_schema. Nothing here applies, repairs, or rolls back a
// migration — `migrate deploy` runs in the Vercel build and this only reports
// what that build did.
//
// ============ WHY A ROW IS NOT ENOUGH ==================================
//
// A row in _prisma_migrations says Prisma recorded the migration. It does not
// say the schema actually changed: a migration whose SQL is a no-op, or one
// marked applied by a repair, records identically to one that did the work.
//
// So each named migration is checked TWICE — the ledger row AND the real column
// it was supposed to create, read from information_schema. The pair is the
// evidence; either alone is a claim.
//
// COLUMNS ARE NAMED HERE, not derived from the migration name. Parsing intent
// out of a migration's filename is guessing; this maps the ones we have pushed
// and reports an unmapped name as unmapped rather than inventing an assertion.

const KNOWN_COLUMNS: Record<string, { table: string; column: string }[]> = {
  "20260914180000_approval_task_identity": [{ table: "ApprovalRequest", column: "taskId" }],
  "20260914120000_store_created_from_draft": [{ table: "Store", column: "createdFromDraftId" }],
};

const envFile = process.argv[2];
const wanted = process.argv.slice(3);

if (envFile) {
  if (!existsSync(envFile)) {
    console.error(`No such env file: ${envFile}`);
    process.exit(1);
  }
  dotenv.config({ path: envFile, override: true });
  console.log(`Loaded environment from: ${envFile}\n`);
} else {
  dotenv.config();
  console.log("No env file named — this is almost certainly your DEV database.\n");
}

let failures = 0;

function assert(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

async function main() {
  const { prismaSystem: prisma } = await import("@/lib/prisma");

  // Host only, credentials stripped — same as every other production check.
  const host = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/\/.*$/, "");
  console.log(`Database host: ${host}\n`);

  // ====================================================================
  console.log("=== 1. THE MIGRATION LEDGER, MOST RECENT FIRST ===\n");
  // ====================================================================
  const recent = await prisma.$queryRawUnsafe<
    { migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }[]
  >(`SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"
     ORDER BY started_at DESC LIMIT 8`);
  for (const m of recent) {
    const when = m.finished_at ? m.finished_at.toISOString().slice(0, 19) : "UNFINISHED".padEnd(19);
    const rolled = m.rolled_back_at ? "  ROLLED BACK" : "";
    console.log(`    ${when}  ${m.migration_name}${rolled}`);
  }

  if (wanted.length === 0) {
    console.log("\n(no migration names given — listing only)");
    await prisma.$disconnect();
    return;
  }

  // ====================================================================
  console.log("\n=== 2. EACH NAMED MIGRATION: LEDGER *AND* SCHEMA ===\n");
  // ====================================================================
  for (const name of wanted) {
    const rows = await prisma.$queryRawUnsafe<{ finished_at: Date | null; rolled_back_at: Date | null }[]>(
      `SELECT finished_at, rolled_back_at FROM "_prisma_migrations" WHERE migration_name = $1`,
      name,
    );
    assert(`${name}: recorded`, rows.length === 1, `${rows.length} row(s)`);
    assert(`  finished`, rows[0]?.finished_at != null, rows[0]?.finished_at?.toISOString() ?? "not finished");
    assert(`  not rolled back`, rows[0]?.rolled_back_at == null, rows[0]?.rolled_back_at?.toISOString() ?? "");

    const columns = KNOWN_COLUMNS[name];
    if (!columns) {
      console.log(`  NOTE  no column mapping for this migration — the ledger row is all this can check`);
      continue;
    }
    // THE HALF A LEDGER ROW CANNOT PROVE.
    for (const { table, column } of columns) {
      const found = await prisma.$queryRawUnsafe<{ data_type: string; is_nullable: string }[]>(
        `SELECT data_type, is_nullable FROM information_schema.columns
          WHERE table_name = $1 AND column_name = $2`,
        table,
        column,
      );
      assert(
        `  ${table}.${column} exists in the real schema`,
        found.length === 1,
        found[0] ? `${found[0].data_type}, nullable=${found[0].is_nullable}` : "absent",
      );
    }
  }

  console.log(`\n${failures === 0 ? "Every named migration is applied and visible in the schema." : `${failures} check(s) FAILED.`}`);
  if (failures > 0) process.exitCode = 1;
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
