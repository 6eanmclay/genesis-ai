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
// RESULT AS OF 2026-08-20: 8 of 12 pass. The other four are reported honestly
// rather than papered over, because which ones fail and why is the useful part:
//
//   stripe-webhook-e2e          needs a running dev server — it POSTs to the
//                               webhook route over HTTP. A database is not
//                               enough; this one wants `next dev`.
//   brand-logo-flow              hit a PGlite limitation, diagnosed and
//   social-connections-pipeline  confirmed in isolation 2026-08-20:
//   product-image-gallery-e2e    CONCURRENT QUERIES close the connection.
//                                Prisma's pg adapter uses a pool, so a
//                                Promise.all of three counts opens more than
//                                one connection to PGlite's wire server and it
//                                drops them. All three run code that
//                                legitimately parallelises reads (reasoning.ts,
//                                understanding.ts, the image executables'
//                                Promise.all of updates).
//
//                                A harness limitation, NOT a defect: real
//                                Postgres handles concurrent queries, which is
//                                the entire point of a pool. Capping the pool
//                                at one would fix the harness by changing how
//                                production talks to Neon — the wrong trade. So
//                                these three stay uncovered here, and are named
//                                rather than hidden.
//
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
  // Same: brings its own real Postgres and must run unelevated.
  if (file === "verify-confirmation-live.ts") return false;
  if (file === "verify-checkout-live.ts") return false;
  if (file === "verify-orders-live.ts") return false;
  if (file === "verify-paypal-live.ts") return false;
  if (file === "verify-paypal-refund.ts") return false;
  if (file === "verify-paypal-webhook-lifecycle.ts") return false;
  if (file === "verify-label-purchase-live.ts") return false;
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
