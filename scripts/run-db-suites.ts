import { startTestDatabase } from "@/scripts/lib/testDatabase";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";
import { execFile } from "child_process";
import { readdirSync } from "fs";

// Run the suites that need a database, against the in-process one:
//
//   npx tsx scripts/run-db-suites.ts
//
// Twelve verification suites had never run locally — they import lib/prisma and
// fail immediately with "Can't reach database server". They contain real
// coverage nobody has been able to execute, which is worse than no coverage,
// because it looks like coverage in a file listing.
//
// Each suite runs as its own child process with DATABASE_URL pointed at the
// harness. Sequentially and deliberately: PGlite queues per connection, so
// concurrent clients interleave and tear each other's transactions down.
//
// RESULT AS OF 2026-08-21: every suite this runner can honestly run, passes.
//
// It said 8 of 12 for a day, and three of the four failures were recorded here
// as an unfixable PGlite limitation: "CONCURRENT QUERIES close the connection —
// capping the pool at one would fix the harness by changing how production
// talks to Neon, the wrong trade."
//
// The diagnosis was right and the conclusion was wrong. PGLiteSocketServer
// takes a `maxConnections` option and DEFAULTS IT TO 1, refusing the second
// client; the pool was never the thing that needed capping. One option in
// scripts/lib/testDatabase.ts fixed all three, with nothing in production and
// nothing in the suites touched. See the comment there.
//
// What that leaves is 13 of 13, and two suites this runner honestly cannot run:
// verify-stripe-webhook-e2e (needs a server it does not start) and
// verify-catalog-browser (brings its own Postgres and server, like the rest of
// that list). Both are excluded and named below rather than left failing.

// The finding that mattered more than the count: these suites were written to
// run against PRODUCTION. Eleven of twelve reach for "a real store", "a real
// product", "a real user" via bare findFirst — which is why none of them had
// ever run locally, and why some of them MUTATE whatever they find. See seed().

import { needsDatabase, SCRIPTS_DIR } from "./lib/suiteLanes";

/** A suite needs a database if it reaches for Prisma, directly or otherwise. */

async function runSuite(
  file: string,
  url: string,
  /** Print the suite's own output verbatim — used when a filter names one suite. */
  streamOutput = false
): Promise<{ file: string; ok: boolean; tail: string }> {
  return new Promise((resolve) => {
    // Through the shell, because tsx is not a local dependency here — it runs
    // from the npx cache, so there is no stable path to hand to execFile.
    execFile(
      `npx tsx scripts/${file}`,
      {
        env: { ...process.env, DATABASE_URL: url, [TEST_DATABASE_ENV]: "1" },
        maxBuffer: 20 * 1024 * 1024,
        shell: true,
      },
      (error, stdout, stderr) => {
        const output = `${stdout}${stderr}`.trimEnd();
        // Stack frames crowd out the actual message, which is the only part
        // anyone reads. Dropped here rather than in each suite.
        const lines = output
          .split("\n")
          .filter((line) => !/^\s+at |node_modules|^\s*$/.test(line));
        if (streamOutput) console.log(output);
        resolve({
          file,
          ok: !error,
          tail: lines.slice(-6).map((line) => line.trim()).join(" | ").slice(0, 300),
        });
      }
    );
  });
}

/**
 * A minimal but realistic store, because these suites were written to run
 * against PRODUCTION.
 *
 * That is the finding this runner surfaced, and it is worth stating plainly:
 * eleven of the twelve reach for "a real store", "a real product", "a real
 * user" via bare findFirst, which is why none of them has ever run locally.
 * Some of them WRITE — verify-product-content-change renames whatever product
 * it finds, which against production renames a live merchant's item.
 *
 * They need no particular data, only *some*. So this seeds one of each.
 */
async function seed(db: Awaited<ReturnType<typeof startTestDatabase>>) {
  const user = await db.prisma.user.create({
    data: { email: "seed-owner@example.test", name: "Seed Owner" },
  });
  const store = await db.prisma.store.create({
    data: {
      userId: user.id,
      name: "Seed Store",
      slug: "seed-store",
      tagline: "A store that exists so the suites can run",
      description: "Seeded by run-db-suites.ts",
      published: true,
    },
  });
  // Several suites need more than one product (approve-pending-changes groups
  // changes across products), and one looks for a fixture BY NAME.
  await db.prisma.product.create({
    data: {
      storeId: store.id,
      name: "Seed Candle",
      description: "A candle that exists so the suites can run",
      priceInCents: 2500,
      active: true,
    },
  });
  await db.prisma.product.create({
    data: {
      storeId: store.id,
      name: "Seed Soap",
      description: "A second product, because grouping needs two",
      priceInCents: 1200,
      active: true,
    },
  });
  await db.prisma.product.create({
    data: {
      storeId: store.id,
      // verify-product-image-gallery-e2e looks for this exact name — a fixture
      // that until now had to exist in the production database.
      name: "DESKTOP Test Product",
      description: "Named fixture for the image-gallery suite",
      priceInCents: 999,
      active: true,
      // WITH an image already attached. The gallery suite asserts that adding
      // to a product that already has one does NOT move the primary — on an
      // empty product the first image legitimately becomes primary, so an
      // empty fixture inverts the precondition and the suite fails for the
      // wrong reason.
      imageUrl: "https://example.test/seed-primary.png",
      images: {
        create: [{ url: "https://example.test/seed-primary.png", position: 0 }],
      },
    },
  });
  await db.prisma.genesisObservation.create({
    data: {
      storeId: store.id,
      dedupeKey: "seed.observation",
      genesisState: "opportunity",
      summary: "A seeded observation so dismissal can be tested",
      status: "ACTIVE",
    },
  });
}

async function main() {
  const db = await startTestDatabase();
  await seed(db);
  // The harness client would otherwise hold a connection each child has to
  // queue behind.
  await db.prisma.$disconnect();

  // An optional substring filter, so one suite can be run against this harness
  // without standing up a second copy of it:
  //
  //   npx tsx scripts/run-db-suites.ts security-events
  //
  // Added while building Security & Trust, where what you need from a failing
  // suite is its own output and what the summary gives you is six lines of
  // stack. No argument is the unchanged default and still runs everything.
  const only = process.argv[2] ?? null;
  const suites = readdirSync(SCRIPTS_DIR)
    .filter((f) => f.startsWith("verify-") && f.endsWith(".ts"))
    .filter(needsDatabase)
    // A COMMA-SEPARATED FILTER, because the interesting failures are about
    // ORDER (2026-08-28). A suite that passes alone and fails after another
    // one cannot be reproduced by a filter that only names a single suite, so
    // diagnosing it meant a five-minute full sweep per experiment. Naming the
    // two or three suites that interact takes seconds and reproduces it
    // exactly. One name still behaves as before.
    .filter((f) => (only ? only.split(",").some((o) => f.includes(o.trim())) : true))
    .sort();

  if (only && suites.length === 0) {
    console.error(`No database-backed suite matches "${only}".`);
    process.exit(1);
  }

  console.log(`Running ${suites.length} database-backed suites against the test database.\n`);

  const results: { file: string; ok: boolean; tail: string }[] = [];
  for (const file of suites) {
    const started = Date.now();
    const result = await runSuite(file, db.url, suites.length === 1);
    results.push(result);
    // SUITE_PROBE=1 shows the harness's connection budget draining. Kept
    // because a full sweep is the only thing that reproduces exhaustion, and
    // without a number the failure looks like it belongs to an innocent suite.
    if (process.env.SUITE_PROBE) {
      const rss = Math.round(process.memoryUsage().rss / 1048576);
      const heap = Math.round(process.memoryUsage().heapUsed / 1048576);
      const s = db.stats();
      console.log(`        probe conns=${s.activeConnections}/${s.maxConnections} queued=${s.queuedQueries} rss=${rss}MB took=${Date.now() - started}ms`);
    }
    console.log(`${result.ok ? "PASS" : "FAIL"}  ${file.replace(/^verify-|\.ts$/g, "")}`);
    if (!result.ok) console.log(`        ${result.tail}`);
  }

  await db.close();

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} database-backed suites pass.`);
  // A suite needing production-shaped data is a real limitation of this
  // harness, not a defect in the code under test — so this reports rather than
  // failing the whole run.
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
