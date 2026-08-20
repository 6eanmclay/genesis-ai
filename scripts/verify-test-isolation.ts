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
    const dir = join(process.cwd(), "scripts");
    const unguarded: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.startsWith("verify-") && f.endsWith(".ts"))) {
      const source = readFileSync(join(dir, file), "utf8");
      // Suites that bring their own database create the marker themselves.
      if (file === "verify-db-integrity.ts" || file === "verify-ledger-live.ts") continue;
      const touchesDatabase = /from "@\/lib\/prisma"|from "\.\.\/lib\/prisma"|prismaSystem/.test(source);
      if (touchesDatabase && !source.includes("requireTestDatabase")) unguarded.push(file);
    }
    check("no unguarded database suite exists", unguarded, []);
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
