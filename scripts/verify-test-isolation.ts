import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import {
  TEST_DATABASE_ENV,
  TEST_DATABASE_MARKER,
  requireTestDatabase,
  NotATestDatabaseError,
} from "@/scripts/lib/requireTestDatabase";
import type { PrismaClient } from "@prisma/client";

// No test can touch real merchant data. No database, no network:
//
//   npx tsx scripts/verify-test-isolation.ts
//
// Eleven verification suites were written to run against PRODUCTION — bare
// findFirst for "a real store", "a real product", "a real user" — and several
// of them mutate what they find. verify-product-content-change renames the
// first product it sees, which against production renames a live merchant's
// item. The only thing standing between a real catalogue and a test run was
// whoever typed the command remembering which DATABASE_URL was in their shell.
//
// Two conditions guard that now, and this file asserts BOTH are load-bearing.
// A guard satisfied by exporting an environment variable would be theatre.

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

/** A Prisma stand-in that reports whether the marker table exists. */
function fakePrisma(markerExists: boolean): PrismaClient {
  return {
    $queryRawUnsafe: async () => [{ exists: markerExists }],
  } as unknown as PrismaClient;
}

async function refuses(label: string, fn: () => Promise<unknown>, expectReason: string): Promise<void> {
  try {
    await fn();
    failures++;
    console.log(`FAIL  ${label} — it did NOT refuse`);
  } catch (error) {
    const ok = error instanceof NotATestDatabaseError && error.message.includes(expectReason);
    if (!ok) failures++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
    if (!ok) console.log(`        expected a NotATestDatabaseError mentioning "${expectReason}"`);
  }
}

async function main() {
  const original = process.env[TEST_DATABASE_ENV];

  // -------------------------------------------------------------------------
  console.log("\n1. The flag alone is not enough");
  {
    // The condition that actually matters. Someone exporting the variable by
    // hand — or a CI job inheriting it — must NOT be able to make production
    // look like a test database, because production has no marker table and
    // these suites never create one.
    process.env[TEST_DATABASE_ENV] = "1";
    await refuses(
      "a real database with the flag set is still refused",
      () => requireTestDatabase(fakePrisma(false)),
      TEST_DATABASE_MARKER
    );
  }

  // -------------------------------------------------------------------------
  console.log("\n2. The marker alone is not enough either");
  {
    // Belt and braces the other way: a leftover marker in some database must
    // not be enough on its own.
    delete process.env[TEST_DATABASE_ENV];
    await refuses(
      "a marked database without the flag is refused",
      () => requireTestDatabase(fakePrisma(true)),
      TEST_DATABASE_ENV
    );

    for (const wrong of ["0", "true", "yes", ""]) {
      process.env[TEST_DATABASE_ENV] = wrong;
      await refuses(`the flag set to "${wrong}" is refused`, () => requireTestDatabase(fakePrisma(true)), TEST_DATABASE_ENV);
    }
  }

  // -------------------------------------------------------------------------
  console.log("\n3. Both together allow it");
  {
    process.env[TEST_DATABASE_ENV] = "1";
    let allowed = true;
    try {
      await requireTestDatabase(fakePrisma(true));
    } catch {
      allowed = false;
    }
    assert("the harness's own database is allowed", allowed);
  }

  // -------------------------------------------------------------------------
  console.log("\n4. The refusal tells you what to do instead");
  {
    delete process.env[TEST_DATABASE_ENV];
    try {
      await requireTestDatabase(fakePrisma(false));
    } catch (error) {
      const message = (error as Error).message;
      // Somebody hits this at the moment they are trying to run a test. It has
      // to say why it stopped and what the right command is, or it just reads
      // as broken tooling and gets worked around.
      assert("it names the risk", message.includes("real merchant"), message.split("\n")[0]);
      assert("and gives the working command", message.includes("run-db-suites.ts"));
    }
  }

  // -------------------------------------------------------------------------
  console.log("\n5. Every database-touching suite is guarded");
  {
    // The realistic regression is not someone removing the guard — it is
    // someone adding a THIRTEENTH suite and not knowing this exists.
    //
    // ============ WHAT THIS ASKED, AND WHY IT WAS WRONG (2026-09-16) =====
    //
    // It matched the database client's NAME against the RAW SOURCE of every
    // suite, so a suite that merely SPELLS that name counted as touching the
    // database. Two did: verify-reference-design and verify-temporary-assets
    // are source-shape tests that read other files' text, and both carry the
    // name inside a regex literal. Neither opens a connection. They were
    // reported as unguarded and the suite sat accepted-red because of it.
    //
    // Prose read as code — the third time this repository has been bitten by
    // exactly that, after suiteLanes classifying a comment and the client
    // boundary checker matching the word "import" inside one.
    //
    // THE FALSE NEGATIVE WAS THE WORSE HALF, and only measuring found it.
    // Fifteen suites that really do reach the client were invisible to this
    // check: they load it through a DYNAMIC import and destructure the plain
    // export, so neither spelling the old pattern looked for appears anywhere
    // in the file. A text search for how an import is usually written cannot
    // see an import written another way.
    //
    // So it asks two real questions instead, both about code rather than text:
    //
    //   1. Does this suite bring its OWN database? Two helper modules start a
    //      throwaway one and write the marker themselves, which is what makes
    //      it safe. That replaces a hardcoded list of two filenames — a list
    //      that was already wrong, since all fifteen suites above are in this
    //      category and were not on it.
    //
    //      ASKED AS AN IMPORT, not as the helpers' function names. suiteLanes
    //      classifies by raw source too, so naming those functions here moved
    //      THIS suite into a different lane — the very mistake being fixed two
    //      paragraphs up, committed while fixing it. The import is the real
    //      signal anyway: a suite cannot start a database it never imported.
    //
    //      THE SAME RULE APPLIES TO THIS COMMENT. suiteLanes reads prose as
    //      code, so the spellings it keys on are deliberately not written out
    //      above. That is a workaround for a real defect in the classifier,
    //      recorded rather than hidden.
    //
    //   2. Otherwise, does it IMPORT prisma — static or dynamic? Then it
    //      connects to whatever DATABASE_URL names, and it must ask
    //      requireTestDatabase first.
    const dir = join(process.cwd(), "scripts");
    const unguarded: string[] = [];
    const ownDatabase: string[] = [];
    /** Source with comments gone, so a sentence is never read as a statement. */
    const codeOnly = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    // ANCHORED TO A LINE START, and with the real path spelling. A regex
    // literal that quotes `from "@\/lib\/prisma"` carries backslashes and does
    // not begin a line with `import`, so it cannot be mistaken for one.
    const STATIC_IMPORT = /^\s*import[^;]*from\s*["'](@\/lib\/prisma|\.\.\/lib\/prisma)["']/m;
    const DYNAMIC_IMPORT = /import\(\s*["'](@\/lib\/prisma|\.\.\/lib\/prisma)["']\s*\)/;
    const OWN_DATABASE = /from\s*["']@\/scripts\/lib\/(realPostgres|testDatabase)["']/;

    for (const file of readdirSync(dir).filter((f) => f.startsWith("verify-") && f.endsWith(".ts"))) {
      const source = codeOnly(readFileSync(join(dir, file), "utf8"));
      // Brings its own database, and the helper writes the marker into it.
      if (OWN_DATABASE.test(source)) {
        ownDatabase.push(file);
        continue;
      }
      const touchesDatabase = STATIC_IMPORT.test(source) || DYNAMIC_IMPORT.test(source);
      if (touchesDatabase && !source.includes("requireTestDatabase")) unguarded.push(file);
    }
    check("no unguarded database suite exists", unguarded, []);
    // NOT VACUOUS. If the own-database rule ever stopped matching, every one of
    // those suites would silently fall into the branch above and this check
    // would start passing for the wrong reason.
    assert(
      "and the own-database rule still recognises the suites that bring one",
      ownDatabase.length > 10,
      `${ownDatabase.length} suites start their own database`,
    );
  }

  if (original === undefined) delete process.env[TEST_DATABASE_ENV];
  else process.env[TEST_DATABASE_ENV] = original;

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
