import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";

// SOURCING ON THE SCHEDULER THAT ALREADY EXISTS:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-sourcing-schedule.ts" -OutFile out.txt
//
// Discovery and the supplier-economics refresh ran only on a Home load. This is
// the fifth stage of the existing CRON_SECRET-gated route, and what is under
// test is the part that is genuinely new: WHICH businesses a bounded pass
// reaches, in what order, and that reaching one cannot be stopped by another.
//
// The gates themselves are NOT re-tested here. They live in
// discoverIfWorthwhile and refreshEconomicsIfStale, are verified in
// verify-catalog-live.ts and verify-economics-producer.ts, and are called from
// this stage unchanged — a second set of assertions about when to look would be
// a second opinion able to drift from the first.

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

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

async function main() {
  const db = await startRealPostgres();
  await db.prisma.$disconnect();

  process.env[TEST_DATABASE_ENV] = "1";
  process.env.DATABASE_URL = db.url;

  const { getStoresDueForSourcing, runDueSourcing } = await import("@/lib/sourcing/sourcingSchedule");
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

  let n = 0;
  async function makeStore(slug: string, over: { description?: string; tagline?: string } = {}) {
    const user = await prisma.user.create({ data: { email: `${slug}-${++n}@example.test` } });
    return prisma.store.create({
      data: {
        userId: user.id, name: slug, slug,
        tagline: over.tagline ?? "t",
        description: over.description ?? "A fitness and recovery brand for training at home.",
        brandPositioning: "minimalist", currency: "USD",
      },
    });
  }

  /** A row that fixes when this business was last looked at. */
  const lookedAt = (storeId: string, when: Date, status: "SUGGESTED" | "RULED_OUT" = "RULED_OUT") =>
    prisma.sourcedProduct.create({
      data: {
        storeId, sourceKey: "printful", externalProductId: `x-${++n}`,
        kind: "WHOLESALE_DROPSHIP", name: `Thing ${n}`, status, score: 0,
        discoveredAt: when,
      },
    });

  try {
    // =======================================================================
    console.log("\n1. Who a bounded pass reaches, and in what order");
    {
      await reset();
      const never = await makeStore("never-looked");
      const old = await makeStore("looked-long-ago");
      const recent = await makeStore("looked-yesterday");
      await lookedAt(old.id, daysAgo(90));
      await lookedAt(recent.id, daysAgo(1));

      const due = await getStoresDueForSourcing(10);
      // NEVER LOOKED AT COMES FIRST. A business nobody has ever searched for is
      // the one most likely to have an empty catalog, and a bounded pass that
      // kept revisiting the head of the queue would never reach it.
      check("least-recently-looked-at first, nulls first",
        due, [never.id, old.id, recent.id]);

      // BOUNDED, so one invocation cannot run away.
      check("a limit is a limit", (await getStoresDueForSourcing(2)).length, 2);
      check("and it takes the front of the queue", await getStoresDueForSourcing(2), [never.id, old.id]);
    }

    // =======================================================================
    console.log("\n2. A business that has said nothing is not reached at all");
    {
      await reset();
      const silent = await makeStore("silent", { description: "", tagline: "" });
      const speaks = await makeStore("speaks");

      // Selection is a SUPERSET of what the gates accept, but there is no point
      // spending two queries per pass on a business that can never pass them.
      check("only the one that described itself", await getStoresDueForSourcing(10), [speaks.id]);

      // A business with only a tagline HAS said something, and the gate reads
      // taglines too — so selection must not exclude it.
      const taglineOnly = await makeStore("tagline-only", { description: "" });
      const due = await getStoresDueForSourcing(10);
      assert("a tagline alone is still something said",
        due.includes(taglineOnly.id), JSON.stringify(due));
      void silent;
    }

    // =======================================================================
    console.log("\n3. Both halves are attempted, and the gates decide");
    {
      await reset();
      // Nothing on its list and nothing looked at: discovery's own gate will
      // let it through and it will genuinely try to search.
      const fresh = await makeStore("fresh");
      // Something already suggested: discovery's gate declines it.
      const stocked = await makeStore("has-list");
      await lookedAt(stocked.id, daysAgo(2), "SUGGESTED");

      const summaries = (await runDueSourcing(10)).stores;
      check("both were reached", summaries.length, 2);

      const forStocked = summaries.find((s) => s.storeId === stocked.id)!;
      check("the one with a list is declined BY THE GATE, not by selection",
        forStocked.discovery, { ran: false, reason: "already_has_suggestions" });
      // The economics half runs regardless of what discovery decided — a
      // discovery that could not run is no reason to leave figures stale.
      assert("and its economics half still ran", forStocked.economics !== null,
        JSON.stringify(forStocked));

      const forFresh = summaries.find((s) => s.storeId === fresh.id)!;
      // No source is connectable in a test harness, so discovery honestly finds
      // nothing rather than pretending. What matters is that it TRIED.
      assert("the empty one was actually attempted",
        forFresh.discovery.ran === true || forFresh.discovery.reason === "failed",
        JSON.stringify(forFresh.discovery));
      assert("and it too got its economics half", forFresh.economics !== null);
    }

    // =======================================================================
    console.log("\n4. One store's failure cannot hold the queue");
    {
      await reset();
      const first = await makeStore("aaa-first");
      const second = await makeStore("bbb-second");
      const third = await makeStore("ccc-third");

      // A row whose recommendation JSON is unreadable is the shape of thing that
      // has taken this codebase's cross-tenant loops down before.
      await prisma.$executeRawUnsafe(
        `INSERT INTO "SourcedProduct"
           ("id","storeId","sourceKey","externalProductId","externalVariantId","kind","name",
            "currency","customizable","status","score","discoveredAt","updatedAt")
         VALUES (gen_random_uuid()::text, $1, 'printful', 'broken', '', 'WHOLESALE_DROPSHIP',
                 'Broken row', 'USD', false, 'SUGGESTED', 0, NOW() - INTERVAL '90 days', NOW())`,
        second.id
      );

      const summaries = (await runDueSourcing(10)).stores;
      check("every store was reached", summaries.length, 3);
      check("including the ones after the awkward one",
        [...summaries.map((s) => s.storeId)].sort(),
        [first.id, second.id, third.id].sort());
      // Each store's own outcome is recorded, so "reached and did nothing" is
      // distinguishable from "never reached".
      assert("each says what happened to it",
        summaries.every((s) => s.discovery !== undefined), JSON.stringify(summaries));
    }

    // =======================================================================
    console.log("\n5. A store already handled elsewhere is not handled twice");
    {
      await reset();
      const a = await makeStore("aa");
      const b = await makeStore("bb");

      const due = await getStoresDueForSourcing(10, [a.id]);
      check("the skipped one is not returned", due, [b.id]);
      // And the limit still means what it says once something is skipped.
      check("and the limit still fills", (await getStoresDueForSourcing(1, [a.id])), [b.id]);
    }

    // =======================================================================
    console.log("\n6. The cron route actually runs the stage");
    {
      // WITHOUT THIS, "wired into the scheduler" is a claim about an import.
      // The route is the only thing that decides whether the stage is reached in
      // production, and a stage that exists and is never called is worth nothing.
      await reset();
      const store = await makeStore("cron-reached");

      process.env.CRON_SECRET = "a-real-cron-secret-for-this-test";
      const { GET } = await import("@/app/api/cron/sync/route");
      const { NextRequest } = await import("next/server");

      // REFUSED WITHOUT THE SECRET, first — the stage must not be reachable by
      // anything that guessed the path.
      const unauthorized = await GET(new NextRequest("https://x.test/api/cron/sync"));
      check("an unauthenticated request is refused", unauthorized.status, 401);

      const response = await GET(
        new NextRequest("https://x.test/api/cron/sync", {
          headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
        })
      );
      check("an authorised one runs", response.status, 200);

      // THE ROUTE NO LONGER OWNS THE STAGES (2026-09-02).
      //
      // These four assertions read a per-stage response shape — a `sourcing`
      // object listing every store it reached — that the cron route stopped
      // producing when the scheduler took over in 838fe95. The route now runs
      // runDueTasks and reports task outcomes: ran, failed, skipped, deferred.
      //
      // Verified before repointing: runDueSourcing itself is unchanged and
      // still returns SourcingRunReport with per-store summaries and
      // stoppedBecause — and the sections above this one drive it directly and
      // assert exactly that. What moved is who calls it, so what belongs here
      // is that the route still reaches it.
      //
      // AND THAT IT IS DELIBERATELY OFF. sourcing.discovery is registered with
      // `enabled: sourcingDiscoveryEnabled`, which reads
      // SOURCING_DISCOVERY_ENABLED — Sean's Slice 1 decision was that discovery
      // stays disabled. So the honest assertion is that the task is registered
      // and SKIPPED, not that it ran: a green 'it ran' here would mean the gate
      // had come off without anybody deciding it.
      const body = (await response.json()) as {
        ran: { key: string }[];
        failed: { key: string; error: string }[];
        skipped: { key: string; why: string }[];
      };
      const named = [...body.ran, ...body.failed, ...body.skipped].map((o) => o.key);
      assert("the scheduler reached sourcing.discovery",
        named.includes("sourcing.discovery"), JSON.stringify(body).slice(0, 300));
      // THE REASON, NOT JUST THE FACT. Sabotage caught this: asserting only
      // that it was skipped passed whether the reason was "not enabled" or
      // "not due", so flipping the gate on left this green. The gate is the
      // property under test, so the gate is what is read.
      assert("and it is skipped BECAUSE discovery is deliberately disabled",
        body.skipped.some((o) => o.key === "sourcing.discovery" && o.why === "not enabled"),
        JSON.stringify(body.skipped));
      assert("no task failed",
        body.failed.length === 0, JSON.stringify(body.failed));
      void store;
      // Isolation is the scheduler's now, and it is asserted three lines up as
      // body.failed being empty — stageErrors was the old route's field and
      // went with it.
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
