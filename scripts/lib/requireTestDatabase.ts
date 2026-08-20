import { PrismaClient } from "@prisma/client";

// The guard that makes it impossible for a verification suite to touch real
// merchant data (2026-08-20).
//
// THE PROBLEM THIS EXISTS FOR. Eleven suites were written to run against
// production. They reach for "a real store", "a real product", "a real user"
// with a bare findFirst — and several of them MUTATE what they find.
// verify-product-content-change renames the first product it sees. Run with a
// production DATABASE_URL, that renames a live merchant's item. Others create
// throwaway stores and orders in whatever database they are pointed at.
//
// Nothing prevented that. The only thing standing between a real customer's
// catalogue and a test run was whoever typed the command remembering which
// DATABASE_URL was in their shell.
//
// TWO CONDITIONS, both required, because either alone is a footgun:
//
//   1. An env var the harness sets. Cheap, and catches the ordinary mistake of
//      running a suite directly with production credentials loaded.
//   2. A MARKER TABLE that only the harness creates. This is the one that
//      actually matters: setting an env var by hand cannot make production
//      look like a test database, because production does not have the table
//      and these suites will never create it.
//
// A guard that could be satisfied by exporting a variable would be theatre.

export const TEST_DATABASE_ENV = "GENESIS_TEST_DATABASE";
export const TEST_DATABASE_MARKER = "_genesis_test_database";

export class NotATestDatabaseError extends Error {
  constructor(reason: string) {
    super(
      `Refusing to run: this is not an isolated test database (${reason}).\n\n` +
        `These suites create, mutate and delete rows. Against production that means\n` +
        `real merchant products, orders and customer records.\n\n` +
        `Run them through the harness instead:\n\n` +
        `    npx tsx scripts/run-db-suites.ts\n`
    );
    this.name = "NotATestDatabaseError";
  }
}

/** Create the marker. Called by the harness, and by nothing else. */
export async function markAsTestDatabase(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS "${TEST_DATABASE_MARKER}" (created_at timestamptz NOT NULL DEFAULT now())`
  );
  await prisma.$executeRawUnsafe(`INSERT INTO "${TEST_DATABASE_MARKER}" DEFAULT VALUES`);
}

/**
 * Refuse to continue unless this is genuinely a throwaway database.
 *
 * Every suite that writes calls this before its first query.
 */
export async function requireTestDatabase(prisma: PrismaClient): Promise<void> {
  if (process.env[TEST_DATABASE_ENV] !== "1") {
    throw new NotATestDatabaseError(`${TEST_DATABASE_ENV} is not set`);
  }

  const rows = await prisma.$queryRawUnsafe<{ exists: boolean }[]>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = '${TEST_DATABASE_MARKER}'
     ) AS exists`
  );
  if (!rows[0]?.exists) {
    throw new NotATestDatabaseError(`no ${TEST_DATABASE_MARKER} table — this database was not created by the harness`);
  }
}
