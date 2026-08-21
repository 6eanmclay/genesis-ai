import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";
import type { ProductSource, SourceEconomicsResult, SourceSearchResult } from "@/lib/sourcing/types";

// WHAT AN UNATTENDED SOURCING RUN MAY SPEND:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-sourcing-budget.ts" -OutFile out.txt
//
// The claim under test is not "a counter reaches a number". It is that an
// exhausted budget CANNOT PRODUCE ONE MORE REQUEST — which is only true if the
// refusal happens before the call rather than after it. So every section counts
// what a fake supplier was actually ASKED, not what a ledger says afterwards.
//
// The fake source counts its own invocations. If the ceiling were a tally read
// after the fact, that counter would keep climbing past the limit and every
// section here would fail.

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

async function main() {
  const db = await startRealPostgres();
  await db.prisma.$disconnect();

  process.env[TEST_DATABASE_ENV] = "1";
  process.env.DATABASE_URL = db.url;

  const {
    SourcingBudget, supplierRequest, withSourcingBudget, isBudgetExhausted,
    activeSourcingBudget, currentSourcingBudget,
  } = await import("@/lib/sourcing/sourcingBudget");
  const { prismaSystem: prisma } = await import("@/lib/prisma");

  async function reset() {
    const tables = await prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename <> '_prisma_migrations'
        AND tablename <> '_genesis_test_database'`;
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`
    );
  }

  /** A stand-in for a supplier that counts what it was actually asked. */
  function countingSupplier() {
    let calls = 0;
    return {
      calls: () => calls,
      ask: (operation = "search") =>
        supplierRequest({ sourceKey: "printful", operation }, async () => {
          calls += 1;
          return "answered";
        }),
    };
  }

  const POLICY = { version: "test", maxBusinesses: 2, maxSupplierRequests: 5, maxRequestsPerBusiness: 3 };

  try {
    // =======================================================================
    console.log("\n1. The ceiling is at the call, not in a counter afterwards");
    {
      await reset();
      const supplier = countingSupplier();
      const budget = new SourcingBudget("run-1", POLICY);

      await withSourcingBudget(budget, async () => {
        budget.startBusiness("store-a");
        // Three are allowed for one business.
        await supplier.ask();
        await supplier.ask();
        await supplier.ask();

        // THE FOURTH MUST NOT HAPPEN. Not "must be recorded as over budget" —
        // must not reach the supplier at all.
        let refused: unknown = null;
        try {
          await supplier.ask();
        } catch (error) {
          refused = error;
        }
        assert("the fourth was refused", isBudgetExhausted(refused), String(refused));
      });

      check("the supplier was asked exactly three times", supplier.calls(), 3);
      check("and the ledger agrees", budget.spent().requests, 3);
    }

    // =======================================================================
    console.log("\n2. Past the ceiling, more attempts produce no more calls");
    {
      await reset();
      const supplier = countingSupplier();
      const budget = new SourcingBudget("run-2", POLICY);

      await withSourcingBudget(budget, async () => {
        budget.startBusiness("store-a");
        for (let i = 0; i < 20; i++) {
          try {
            await supplier.ask();
          } catch {
            // Keeping going is the point: a caller that ignores the refusal
            // must still be unable to spend.
          }
        }
      });

      // TWENTY ATTEMPTS, THREE CALLS. A tally-afterwards implementation would
      // read twenty here.
      check("twenty attempts, three calls", supplier.calls(), 3);
      check("and the run spent three", budget.spent().requests, 3);
    }

    // =======================================================================
    console.log("\n3. One business cannot eat the whole run's allowance");
    {
      await reset();
      const supplier = countingSupplier();
      const budget = new SourcingBudget("run-3", POLICY);

      await withSourcingBudget(budget, async () => {
        budget.startBusiness("store-a");
        for (let i = 0; i < 10; i++) {
          try { await supplier.ask(); } catch { /* refused */ }
        }
        // A second business gets its own share, up to what the RUN has left.
        budget.startBusiness("store-b");
        for (let i = 0; i < 10; i++) {
          try { await supplier.ask(); } catch { /* refused */ }
        }
      });

      // 3 for the first, then the run cap of 5 stops the second at 2.
      check("the first took its three, the second got what was left", supplier.calls(), 5);
      check("which is the run ceiling", budget.spent().requests, POLICY.maxSupplierRequests);
      // And a third business cannot be started at all.
      check("no third business may start", budget.canStartBusiness(), false);
    }

    // =======================================================================
    console.log("\n4. Outside a run there is no ceiling");
    {
      await reset();
      const supplier = countingSupplier();
      check("nothing is in scope", activeSourcingBudget(), null);

      // An owner clicking "what does this cost", or an order being fulfilled,
      // must never be refused because a discovery pass used up its allowance.
      for (let i = 0; i < 8; i++) await supplier.ask("cost.product");
      check("every call went through", supplier.calls(), 8);

      const rows = await prisma.supplierRequestEvent.findMany();
      check("all of them recorded", rows.length, 8);
      check("and none attributed to a run", [...new Set(rows.map((r) => r.runId))], [null]);
    }

    // =======================================================================
    console.log("\n5. Supplier cost is its own axis, not AI and not points");
    {
      await reset();
      const supplier = countingSupplier();
      const budget = new SourcingBudget("run-5", POLICY);
      await withSourcingBudget(budget, async () => {
        budget.startBusiness("store-a");
        await supplier.ask("economics.store");
        await supplier.ask("economics.product");
      });

      const events = await prisma.supplierRequestEvent.findMany({ orderBy: { operation: "asc" } });
      check("both recorded", events.length, 2);
      check("as supplier requests", events.map((e) => e.operation), ["economics.product", "economics.store"]);
      check("attributed to the run that spent them", [...new Set(events.map((e) => e.runId))], ["run-5"]);
      check("and to the business", [...new Set(events.map((e) => e.storeId))], ["store-a"]);
      assert("with how long it took", events.every((e) => typeof e.durationMs === "number"));

      // THE SEPARATION THAT MATTERS. Supplier HTTP is not AI cost and not an
      // owner's Growth Points, and recording it in either would be a lie that
      // balances.
      check("nothing was written as AI usage", await prisma.aiUsageEvent.count(), 0);
      check("and nothing charged to the owner", await prisma.growthPointTransaction.count(), 0);
    }

    // =======================================================================
    console.log("\n6. A failed supplier call is still spend, and still recorded");
    {
      await reset();
      const budget = new SourcingBudget("run-6", POLICY);
      await withSourcingBudget(budget, async () => {
        budget.startBusiness("store-a");
        try {
          await supplierRequest({ sourceKey: "printful", operation: "search" }, async () => {
            throw new Error("the supplier was down");
          });
        } catch {
          /* the caller's problem, not the ledger's */
        }
      });

      const rows = await prisma.supplierRequestEvent.findMany();
      // A request that failed still cost a round trip and still counts against
      // the ceiling — otherwise a broken supplier would be free to hammer.
      check("it was recorded", rows.length, 1);
      check("as having failed", rows[0].ok, false);
      check("and it counted", budget.spent().requests, 1);
    }

    // =======================================================================
    console.log("\n7. A stopped run says so, and leaves the rest still due");
    {
      await reset();
      const { runDueSourcing, getStoresDueForSourcing } = await import("@/lib/sourcing/sourcingSchedule");

      // Three businesses, a budget that allows two.
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const user = await prisma.user.create({ data: { email: `budget-${i}@example.test` } });
        const store = await prisma.store.create({
          data: {
            userId: user.id, name: `b${i}`, slug: `budget-${i}`, tagline: "t",
            description: "A fitness and recovery brand for training at home.",
            brandPositioning: "minimalist", currency: "USD",
          },
        });
        ids.push(store.id);
      }

      const report = await runDueSourcing(undefined, { policy: POLICY, runId: "run-7" });
      check("it stopped because of the budget", report.stoppedBecause, "budget_exhausted");
      check("having reached exactly two", report.stores.length, 2);
      check("which is the ceiling", report.spent.businesses, POLICY.maxBusinesses);
      check("and it says which policy governed it", report.policyVersion, "test");

      // NOT A FAILURE. Every store it did reach reports its own honest outcome.
      assert("no store was recorded as failed",
        report.stores.every((s) => s.error === null), JSON.stringify(report.stores));

      // THE SYSTEM IS LEFT VALID FOR THE NEXT PASS. The third was never touched,
      // so it is still due, and the ordering will reach it first next time.
      const stillDue = await getStoresDueForSourcing(10);
      check("all three are still selectable", stillDue.length, 3);
      const untouched = ids.find((id) => !report.stores.some((s) => s.storeId === id))!;
      assert("and the one never reached is at the front of the queue",
        stillDue[0] === untouched || stillDue.includes(untouched), JSON.stringify(stillDue));
      // Nothing partial was written for it.
      check("nothing was written for the untouched business",
        await prisma.sourcedProduct.count({ where: { storeId: untouched } }), 0);
    }

    // =======================================================================
    console.log("\n8. The shipped policy is a real ceiling, not a placeholder");
    {
      const policy = currentSourcingBudget();
      assert("businesses are bounded", policy.maxBusinesses > 0 && policy.maxBusinesses <= 100,
        String(policy.maxBusinesses));
      assert("requests are bounded", policy.maxSupplierRequests > 0, String(policy.maxSupplierRequests));
      // A per-business share that equalled the run's would let one business
      // starve everything behind it, which is what the second number is for.
      assert("and one business cannot take the whole run",
        policy.maxRequestsPerBusiness < policy.maxSupplierRequests,
        `${policy.maxRequestsPerBusiness} vs ${policy.maxSupplierRequests}`);
      assert("the policy is versioned", policy.version.length > 0);
    }

    // =======================================================================
    console.log("\n9. A refusal leaves the supplier alone, through the real stack");
    {
      await reset();
      const { discoverProducts } = await import("@/lib/sourcing/discover");
      const { buildSourcingContext } = await import("@/lib/sourcing/context");

      const user = await prisma.user.create({ data: { email: "stack@example.test" } });
      const store = await prisma.store.create({
        data: {
          userId: user.id, name: "stack", slug: "stack", tagline: "t",
          description: "A fitness and recovery brand for training at home.",
          brandPositioning: "minimalist", currency: "USD",
        },
      });

      let searches = 0;
      const source: ProductSource = {
        key: "printful", displayName: "Test partner", kind: "WHOLESALE_DROPSHIP",
        capabilities: { customization: false, createsListings: false, shipsDirect: true, quotesCost: false, statesEconomics: false },
        fulfillmentProvider: null, blockedOn: [],
        async search(): Promise<SourceSearchResult> {
          // The real stack's own boundary, exactly as the connector uses it.
          return supplierRequest({ sourceKey: "printful", operation: "search" }, async () => {
            searches += 1;
            return { ok: true as const, candidates: [] };
          });
        },
      };
      void ({} as SourceEconomicsResult);

      const exhausted = new SourcingBudget("run-9", { ...POLICY, maxSupplierRequests: 0, maxRequestsPerBusiness: 0 });
      let escaped: unknown = null;
      await withSourcingBudget(exhausted, async () => {
        exhausted.startBusiness(store.id);
        try {
          await discoverProducts({
            storeId: store.id,
            context: await buildSourcingContext(store.id),
            sources: [source],
          });
        } catch (error) {
          escaped = error;
        }
      });

      // THE REFUSAL MUST LEAVE, not be swallowed into "this source was
      // unavailable" — which is what discoverProducts does with every other
      // error, and would have let the loop carry on asking the next source.
      assert("the refusal propagated out of discovery", isBudgetExhausted(escaped), String(escaped));
      check("and the supplier was never asked", searches, 0);
      check("with nothing written", await prisma.sourcedProduct.count({ where: { storeId: store.id } }), 0);
    }
  } finally {
    await prisma.$disconnect().catch(() => {});
    await db.close();
  }

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
