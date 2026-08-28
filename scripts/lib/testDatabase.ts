import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { execFile } from "child_process";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { MARK_TEST_DATABASE_SQL, TEST_DATABASE_MARKER } from "./requireTestDatabase";

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
   * The connection string this harness is serving.
   *
   * Set DATABASE_URL to this BEFORE importing anything that pulls in
   * lib/prisma.ts — that module builds its client at import time, so a suite
   * wanting to exercise the app's OWN functions (rather than a client it made
   * itself) has to point the environment at the test database first.
   */
  url: string;
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
  /** TEMPORARY PROBE: live connection accounting from the socket server. */
  stats(): { activeConnections: number; queuedQueries: number; maxConnections: number };
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
  // MORE THAN ONE CONNECTION, because Prisma's pg adapter is a POOL (2026-08-21).
  //
  // PGLiteSocketServer defaults `maxConnections` to 1 and REJECTS the second
  // client outright, which the pg pool surfaces as "Server has closed the
  // connection" — a message that points at the query unlucky enough to be
  // second rather than at the pool that opened it. Three suites failed here for
  // months and were recorded as an unfixable PGlite limitation, because the
  // symptom names the wrong thing.
  //
  // Nothing about that was a defect in the code under test. `getBusinessProfile`
  // parallelises its record reads, the image executables parallelise their
  // updates — all correct against a real pooled Postgres, and all of it
  // arriving here as a second connection the server had been told to refuse.
  //
  // The server queues across handlers (`queryQueue.enqueue(handlerId, ...)`),
  // so raising the cap serialises the work rather than running it concurrently
  // against the single PGlite session. Slower than real Postgres, and correct,
  // which is the right trade for a harness.
  //
  // THE ALTERNATIVE WAS CAPPING THE POOL, and it was the wrong one: the only
  // seam for that is `new PrismaPg(...)` in lib/prisma.ts, so the harness would
  // have been changing how PRODUCTION talks to Neon in order to make a test
  // pass. Neither `?connection_limit=1` nor `?max=1` reaches a pg Pool built
  // from a connection string — both were tried and both still failed.
  //
  // AND THE NUMBER SCALES WITH THE SUITE COUNT, not with concurrency (2026-08-22).
  //
  // This server outlives every child process in the run, and the handler a
  // child's pool opens is not given back when that child exits. So the cap is
  // consumed cumulatively, roughly one per suite — which made 20 exactly enough
  // for 30 suites and one short for 31. Adding a single new suite failed a
  // completely unrelated one 16 places later, at a query that passes perfectly
  // well standalone, with "Connection terminated unexpectedly" naming neither
  // the cause nor the suite responsible.
  //
  // Found by removing the new suite (the run went straight back to 30/30),
  // ruling out its fixture data (deleting everything it created changed
  // nothing), and then raising this number. Set with real headroom for that
  // reason: the failure it produces is a false report against innocent code,
  // and it arrives whenever somebody writes the next suite.
  // MAX CONNECTIONS IS A BUDGET FOR THE WHOLE RUN, NOT FOR ONE SUITE.
  //
  // ============ MEASURED, 2026-08-28 ====================================
  //
  // This was 60, and the run reached it. `getStats().activeConnections`,
  // sampled after every suite in a full sweep, climbs monotonically across the
  // run and does not fall when a child exits:
  //
  //     ... suite 34   conns=48/60
  //     ... suite 39   conns=50/60
  //     ... suite 40   conns=60/60   <- saturated
  //     FAIL two-factor            Connection terminated unexpectedly
  //     FAIL update-product-image  Connection terminated unexpectedly
  //
  // The server refuses a connection past the cap by writing "Too many
  // connections" and ending the socket, which reaches the client as exactly
  // that error. So the two suites that failed were the two that happened to run
  // after the budget ran out; both pass alone, and both pass in any smaller
  // selection. THE FAILURE HAD NOTHING TO DO WITH THE SUITES IT LANDED ON.
  //
  // A handler is removed from the set on the socket's `close` event, so this is
  // not meant to accumulate — but empirically it does, and a suite closing its
  // own clients does not release it either (verified: adding $disconnect to the
  // heaviest suite left the count unchanged). Rather than pretend to fix
  // pglite-socket's accounting from outside, the budget is now sized for a
  // whole run with room to grow.
  //
  // WHAT THIS IS NOT: it is not a fix for whichever suite happened to be added
  // last. The run stood at 50 of 60 before the newest suite existed, so it was
  // one or two suites away from this failure regardless of what came next, and
  // the next person to add a suite would have paid for it instead. Set
  // SUITE_PROBE=1 on run-db-suites.ts to watch the count.
  const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1", maxConnections: 1000 });
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

  // Stamp it as a throwaway, so requireTestDatabase can tell this apart from
  // production by something stronger than an environment variable anyone could
  // export.
  //
  // AFTER the migrations, not before: `migrate deploy` refuses with P3005 on a
  // database whose schema is not empty, and a single marker table is enough to
  // trip that.
  //
  // And through PGlite directly rather than Prisma: $executeRawUnsafe over the
  // wire protocol fails on DDL and leaves the connection closed, which surfaces
  // as every later query in the process failing with "Server has closed the
  // connection" — nothing pointing at the CREATE TABLE that caused it.
  await db.exec(MARK_TEST_DATABASE_SQL);

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

  return {
    prisma,
    url,
    stats: () => server.getStats(),
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
        WHERE schemaname = 'public'
          AND tablename <> '_prisma_migrations'
          AND tablename <> ${TEST_DATABASE_MARKER}`;
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
