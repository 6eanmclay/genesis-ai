import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { execFile } from "child_process";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// A real Postgres, in this process, for tests that need one (2026-08-20).
//
// Twelve verification suites could not run locally, and every fix in
// database-bound code — order idempotency, the Growth Point ledger's actual
// transaction, the webhook's existence checks — was verified by reading rather
// than by running. This closes that.
//
// WHY NOT THE PRODUCTION DATABASE. The obvious shortcut is to point the suites
// at DATABASE_URL and roll back. That is one bad transaction boundary away from
// mutating a real merchant's store, and Sean's standing rule is that
// verification scripts never touch real account data. Nothing here can reach
// production: the connection string is built from a port this file opened.
//
// WHY PGlite. It is already a dependency, needs no Docker, no service, and no
// credential — so this harness works on any machine that can run the repo,
// which is the only way it will actually get used. It speaks the real Postgres
// wire protocol over a local socket, so Prisma connects to it exactly as it
// connects to Neon: same client, same adapter, same migrations, same SQL.
//
// The schema is built by running THE REAL MIGRATION FILES, not `db push`. A
// harness that invents its own schema tests a database that does not exist —
// and it would have missed, for instance, whether a migration actually applies
// cleanly, which is half of what a migration is for.

export interface TestDatabase {
  prisma: PrismaClient;
  /**
   * Run something expected to fail, and return whether it did.
   *
   * PGlite's wire server CLOSES THE CONNECTION on any Postgres-level error —
   * so after a deliberate constraint violation the client is dead and every
   * later query fails with "Server has closed the connection", which looks
   * exactly like a broken test rather than a healed one. $disconnect() forces
   * a fresh connection on the next query. That is a property of this harness,
   * not of Postgres, and it is handled here so no suite has to know.
   */
  expectRejected(fn: () => Promise<unknown>): Promise<boolean>;
  /** Truncate every table, so each suite starts from nothing. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

/** A high, fixed-ish port so a stray process cannot collide with a real Postgres. */
function pickPort(): number {
  // Deterministic per-process rather than random: Math.random is banned in some
  // of this repo's tooling, and a fixed offset from the pid is unique enough
  // for a machine running a handful of suites.
  return 55000 + (process.pid % 9000);
}

export async function startTestDatabase(): Promise<TestDatabase> {
  // pgcrypto, because a real migration needs it: the product-image-gallery
  // migration calls gen_random_uuid() to backfill ids. Loading the extension
  // here is what lets the REAL migration files run unaltered — the moment a
  // harness starts editing migrations to suit itself, it stops testing the
  // thing that will actually run against production.
  const db = await PGlite.create({ extensions: { pgcrypto } });
  // The socket server will accept connections the moment it binds, so the
  // database must genuinely be up first or the first handshake fails.
  await db.waitReady;
  const port = pickPort();
  const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1" });
  await server.start();

  // PGlite's wire server accepts any credentials; the database name is fixed.
  // sslmode=disable because it speaks plain wire protocol — without it the
  // client opens with an SSL request that never gets a sensible answer, and the
  // failure surfaces as the thoroughly misleading "Can't reach database server".
  const url = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres?sslmode=disable`;

  // The real migrations, applied in order, by Prisma itself.
  //
  // ASYNC, and that is load-bearing rather than stylistic. PGlite's wire server
  // runs on THIS process's event loop, so a synchronous child process would
  // block the very server the migration is trying to talk to — the migration
  // hangs forever and the cause is not obvious from the outside.
  //
  // The CLI is invoked through node against its own entry point rather than
  // through `npx`: on Windows npx is a .cmd, which spawn refuses without a
  // shell, and going through a shell to run a binary that is already on disk
  // buys nothing.
  await new Promise<void>((resolve, reject) => {
    execFile(
      process.execPath,
      ["node_modules/prisma/build/index.js", "migrate", "deploy"],
      { env: { ...process.env, DATABASE_URL: url } },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`migrate deploy failed against the test database:
${stdout}
${stderr}`));
          return;
        }
        resolve();
      }
    );
  });

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

  return {
    prisma,
    async expectRejected(fn) {
      try {
        await fn();
        return false;
      } catch (error) {
        // Heal ONLY after an error that actually reached Postgres. Prisma
        // errors carry a `code`; the tenant-isolation guard throws a plain
        // Error before any query is sent, and disconnecting a perfectly
        // healthy connection there breaks the NEXT query instead — which is
        // exactly the confusing failure this check exists to prevent.
        if (typeof (error as { code?: unknown }).code === "string") {
          // Disconnecting is not enough on its own: the dead socket is still in
          // the pool from Prisma's point of view, so the NEXT real query is the
          // one that fails. Force it here, against a trivial statement, until a
          // fresh connection actually answers.
          for (let attempt = 0; attempt < 3; attempt++) {
            await prisma.$disconnect().catch(() => {});
            try {
              await prisma.$queryRaw`SELECT 1`;
              break;
            } catch {
              // Try again with another fresh connection.
            }
          }
        }
        return true;
      }
    },
    async reset() {
      // Every table except Prisma's own migration bookkeeping, which must
      // survive or the schema would look unmigrated.
      const tables = await prisma.$queryRaw<{ tablename: string }[]>`
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
      if (tables.length === 0) return;
      const list = tables.map((t) => `"${t.tablename}"`).join(", ");
      await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
    },
    async close() {
      await prisma.$disconnect();
      await server.stop();
      await db.close();
    },
  };
}
