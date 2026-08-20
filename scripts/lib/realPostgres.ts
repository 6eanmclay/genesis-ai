import EmbeddedPostgres from "embedded-postgres";
import { execFile } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { MARK_TEST_DATABASE_SQL } from "./requireTestDatabase";

// A REAL Postgres, for the tests PGlite cannot serve (2026-08-20).
//
// WHY A SECOND HARNESS. scripts/lib/testDatabase.ts (PGlite) is smaller, starts
// faster, and is right for suites that make one query at a time. But PGlite's
// wire server drops the connection the moment a client opens a second one — and
// Prisma's pg adapter is a POOL, so any `Promise.all` of queries does exactly
// that. Three verification suites hit it, and so does a real Next server, which
// makes concurrent queries as a matter of course.
//
// That ruled out the only honest way to test the merchant webhook's
// order-creation branch. It ends in Next's `after()`, which throws outside a
// request scope, so the actual handler can only be exercised through a real
// server — and a real server needs a database that tolerates a connection pool.
//
// The alternatives were worse. Capping the production pool at one connection
// would fix the harness by changing how production talks to Neon. Stubbing
// `after()` would test a route that does not exist. Reaching into Next's private
// work-async-storage would break on a minor version. Running a real Postgres
// costs a dev dependency and about a second of startup, and changes nothing
// about the code under test.
//
// Same guarantees as the PGlite harness: a throwaway data directory, a port this
// process opened, the REAL migration files, and the test-database marker so
// scripts/lib/requireTestDatabase.ts can tell it apart from production.

export interface RealPostgres {
  url: string;
  prisma: PrismaClient;
  reset(): Promise<void>;
  close(): Promise<void>;
}

function pickPort(): number {
  return 47000 + (process.pid % 9000);
}

export async function startRealPostgres(): Promise<RealPostgres> {
  const dataDir = mkdtempSync(join(tmpdir(), "genesis-pg-"));
  const port = pickPort();

  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "postgres",
    password: "postgres",
    port,
    persistent: false,
  });

  await pg.initialise();
  await pg.start();
  await pg.createDatabase("genesis_test");

  const url = `postgresql://postgres:postgres@127.0.0.1:${port}/genesis_test`;

  // The real migrations. Async, so nothing blocks the event loop.
  await new Promise<void>((resolve, reject) => {
    execFile(
      process.execPath,
      ["node_modules/prisma/build/index.js", "migrate", "deploy"],
      { env: { ...process.env, DATABASE_URL: url } },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`migrate deploy failed:\n${stdout}\n${stderr}`));
        else resolve();
      }
    );
  });

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

  // Marked AFTER migrations — `migrate deploy` refuses P3005 on a non-empty
  // schema. Unlike PGlite this one takes DDL through Prisma without complaint.
  for (const statement of MARK_TEST_DATABASE_SQL.split("; ")) {
    await prisma.$executeRawUnsafe(statement);
  }

  return {
    url,
    prisma,
    async reset() {
      const tables = await prisma.$queryRaw<{ tablename: string }[]>`
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename <> '_prisma_migrations'
          AND tablename <> '_genesis_test_database'`;
      if (tables.length === 0) return;
      const sql = `TRUNCATE TABLE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`;

      // Retried on deadlock, and that is worth explaining rather than looking
      // like flake-tolerance.
      //
      // When a suite drives a real server, work scheduled by Next's `after()`
      // is STILL RUNNING after the response came back — that is the entire
      // point of it. So a reset between sections races the previous section's
      // post-response sweep: TRUNCATE wants an AccessExclusiveLock while the
      // sweep holds an AccessShareLock, and Postgres picks one to kill (40P01).
      //
      // Nothing about the product is wrong here; the test simply moved on
      // faster than the work it triggered. Backing off and retrying lets the
      // sweep finish. If it never does, the error surfaces rather than being
      // swallowed.
      for (let attempt = 0; ; attempt++) {
        try {
          await prisma.$executeRawUnsafe(sql);
          return;
        } catch (error) {
          const deadlock = (error as { meta?: { code?: unknown } })?.meta?.code === "40P01"
            || String((error as Error)?.message ?? "").includes("deadlock detected");
          if (!deadlock || attempt >= 4) throw error;
          await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
        }
      }
    },
    async close() {
      // EVERY step is guarded, and that matters more than it looks.
      //
      // close() is called from a `finally`, so anything it throws REPLACES the
      // error the suite was actually reporting — and then a real assertion
      // failure surfaces as "EBUSY: resource busy" with no trace of the thing
      // that went wrong. That cost a debugging round: `persistent: false` makes
      // embedded-postgres delete the data directory itself during stop(), which
      // races Windows still holding a handle on it.
      //
      // Cleaning up a temp directory is never worth losing a test failure over.
      await prisma.$disconnect().catch(() => {});
      await pg.stop().catch(() => {});
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {
        // Windows holds handles briefly after shutdown. The directory is under
        // the OS temp root and will be swept up there.
      }
    },
  };
}
