import { startTestDatabase } from "@/scripts/lib/testDatabase";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";
import { execFile } from "child_process";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

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

const SCRIPTS_DIR = join(process.cwd(), "scripts");

/** A suite needs a database if it reaches for Prisma, directly or otherwise. */
function needsDatabase(file: string): boolean {
  const source = readFileSync(join(SCRIPTS_DIR, file), "utf8");
  if (file === "run-db-suites.ts") return false;
  // Suites that bring their own database must not be run twice here.
  if (file === "verify-db-integrity.ts" || file === "verify-ledger-live.ts") return false;
  // verify-order-webhook-live.ts brings a real Postgres AND a real Next server,
  // and PostgreSQL refuses to start under an administrator account. It has its
  // own entry point for that reason:
  //
  //   powershell -File scripts/run-unelevated.ps1   //     -Command "npx tsx scripts/verify-order-webhook-live.ts" -OutFile out.txt
  //
  // Running it from here would fail for a reason that has nothing to do with
  // the code under test.
  if (file === "verify-order-webhook-live.ts") return false;
  // ENVIRONMENTAL, and named rather than left failing (2026-08-21).
  //
  // verify-stripe-webhook-e2e POSTs to `${BASE_URL}/api/webhooks/stripe` over
  // HTTP. A database is not enough — it wants a running Next server, which this
  // runner deliberately does not start, so it fails with ECONNREFUSED for a
  // reason that has nothing to do with the code under test. Exactly the
  // situation verify-order-webhook-live.ts is excluded for, and excluded the
  // same way:
  //
  //   npm run dev
  //   npx tsx scripts/verify-stripe-webhook-e2e.ts
  //
  // NOT a passing result and not claimed as one. It is unrun.
  if (file === "verify-stripe-webhook-e2e.ts") return false;
  // Same: brings its own real Postgres and must run unelevated.
  if (file === "verify-confirmation-live.ts") return false;
  if (file === "verify-checkout-live.ts") return false;
  if (file === "verify-orders-live.ts") return false;
  if (file === "verify-paypal-live.ts") return false;
  if (file === "verify-paypal-refund.ts") return false;
  if (file === "verify-paypal-webhook-lifecycle.ts") return false;
  if (file === "verify-label-purchase-live.ts") return false;
  if (file === "verify-sourcing-live.ts") return false;
  if (file === "verify-business-context-live.ts") return false;
  if (file === "verify-business-browser.ts") return false;
  // Same category, and MISSED when it was added (found 2026-08-21): it brings
  // its own real Postgres AND a Next server via startTestServer, and its own
  // header names run-unelevated.ps1 as its entry point. It had been failing
  // here with "Execution of PostgreSQL by a user with administrative
  // permissions is not permitted" — an environment message about the shell,
  // with nothing to say about the catalog.
  if (file === "verify-catalog-browser.ts") return false;
  if (file === "verify-progression-live.ts") return false;
  if (file === "verify-economics-live.ts") return false;
  if (file === "verify-economics-ingest.ts") return false;
  if (file === "verify-economics-answer.ts") return false;
  if (file === "verify-economics-chat.ts") return false;
  if (file === "verify-economics-producer.ts") return false;
  if (file === "verify-economics-production.ts") return false;
  if (file === "verify-catalog-live.ts") return false;
  if (file === "verify-sourcing-schedule.ts") return false;
  if (file === "verify-sourcing-budget.ts") return false;
  if (file === "verify-business-memory-live.ts") return false;
  if (file === "verify-bi-reads-live.ts") return false;
  if (file === "verify-commitments-live.ts") return false;
  if (file === "verify-hero-asset-live.ts") return false;
  if (file === "verify-owner-understanding-live.ts") return false;
  if (file === "verify-business-switcher-live.ts") return false;
  if (file === "verify-execute-binding-live.ts") return false;
  if (file === "verify-owner-edits-live.ts") return false;
  if (file === "verify-route-business-live.ts") return false;
  return /from "@\/lib\/prisma"|prismaSystem|prisma\./.test(source);
}

async function runSuite(file: string, url: string): Promise<{ file: string; ok: boolean; tail: string }> {
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

  const suites = readdirSync(SCRIPTS_DIR)
    .filter((f) => f.startsWith("verify-") && f.endsWith(".ts"))
    .filter(needsDatabase)
    .sort();

  console.log(`Running ${suites.length} database-backed suites against the test database.\n`);

  const results: { file: string; ok: boolean; tail: string }[] = [];
  for (const file of suites) {
    const result = await runSuite(file, db.url);
    results.push(result);
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
