import "@/scripts/lib/allowServerOnly";
import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import {
  runDueIntelligenceCycles,
  runIntelligenceCycle,
  getStoresDueForIntelligence,
  INTELLIGENCE_MAX_AGE_MS,
} from "@/lib/intelligence/cycle";

// WAKING J4 ON A SCHEDULE, AND STAYING QUIET WHEN NOTHING CHANGED:
//
//   part of the database sweep — npx tsx scripts/run-db-suites.ts intelligence-cadence-db
//
// ============ WHAT SLICE 1 CHANGED (2026-09-02) =======================
//
// Two things, and neither is a new detector. The scheduler can now actually
// reach `intelligence.cycles` (see verify-scheduler-db.ts), and elapsed time
// is now a reason for a store to be due, so a business whose data has not
// moved is still re-evaluated daily.
//
// Which makes the interesting question the opposite of the usual one. It is
// not "does it find things" — the detectors are unchanged and already proved
// elsewhere. It is "does re-running on unchanged data stay silent", because a
// cycle that ran daily and told the owner the same thing every day would be
// worse than one that never ran at all.
//
// ============ AND WHAT lastIntelligenceAt MEANS =======================
//
// The most dangerous thing in this slice is a timestamp that lies. If a failed
// pass recorded an evaluation, the store would drop out of the queue for a day
// having been told nothing, and the failure would look exactly like a healthy
// pass that found nothing. So the semantics are asserted directly and from
// both sides: written on completion, and NOT written on failure.

let failures = 0;
let passes = 0;
const failed: string[] = [];
function assert(name: string, ok: boolean, detail = ""): void {
  if (ok) passes++;
  else {
    failures++;
    failed.push(`${name}${detail ? `  — ${detail}` : ""}`);
  }
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  — ${detail}` : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  assert(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function main(): Promise<void> {
  await requireTestDatabase(prismaSystem);
  const stamp = Date.now();
  let seq = 0;

  const makeStore = async (name = "Cubit & Coil") => {
    const n = ++seq;
    const user = await prisma.user.create({ data: { email: `cad-${stamp}-${n}@example.test` } });
    const store = await prisma.store.create({
      data: {
        userId: user.id, name, slug: `cad-${stamp}-${n}`,
        description: "Copper tensor rings wound by hand.", currency: "USD",
      },
    });
    return store;
  };

  const lastAt = async (storeId: string) =>
    (await prismaSystem.store.findUnique({ where: { id: storeId }, select: { lastIntelligenceAt: true } }))
      ?.lastIntelligenceAt ?? null;

  const countsFor = async (storeId: string) => ({
    observations: await prismaSystem.genesisObservation.count({ where: { storeId } }),
    active: await prismaSystem.genesisObservation.count({ where: { storeId, status: "ACTIVE" } }),
    deliveries: await prismaSystem.proactiveDelivery.count({ where: { storeId } }),
    beliefs: await prismaSystem.belief.count({ where: { storeId } }),
    outputs: await prismaSystem.cognitiveOutput.count({ where: { storeId } }),
    messages: await prismaSystem.storeMessage.count({ where: { storeId } }),
  });

  // ======================================================================
  console.log("\n=== 1. The cadence is inherited, not invented ===\n");
  // ======================================================================
  {
    // Sean: "determine N from the architecture rather than picking an
    // arbitrary interval." Three places already said a day, and this asserts
    // they still agree rather than trusting the comment that says so.
    eq("the intelligence floor is 24 hours", INTELLIGENCE_MAX_AGE_MS, 24 * 60 * 60 * 1000);

    const { SCHEDULED_TASKS } = await import("@/lib/scheduler/registry");
    const cycles = SCHEDULED_TASKS.find((t) => t.key === "intelligence.cycles");
    eq("and matches the task's own declared interval", cycles?.everyMs, INTELLIGENCE_MAX_AGE_MS);
  }

  // ======================================================================
  console.log("\n=== 2. Only a completed pass counts as an evaluation ===\n");
  // ======================================================================
  {
    const store = await makeStore();
    eq("a new store has never been evaluated", await lastAt(store.id), null);

    const summary = await runIntelligenceCycle(store.id);

    if (summary.ok) {
      const at = await lastAt(store.id);
      assert("a completed pass records when it happened", at !== null, "still null after ok: true");
      assert("and the timestamp is now, not a guess",
        at !== null && Math.abs(Date.now() - at.getTime()) < 60_000, String(at));
    } else {
      // THE FAILING CASE IS THE ONE THAT MATTERS, and in this environment it is
      // the one that usually happens: the AI review stage needs a provider.
      // A pass that failed must leave no trace of success behind it.
      eq("a failed pass records NO evaluation", await lastAt(store.id), null);
      assert("and says which stage failed rather than reporting empty success",
        summary.failedStages.length > 0, JSON.stringify(summary));
      console.log(`  NOTE  the cycle failed at [${summary.failedStages.join(", ")}] in this environment, which is the case this section most needs to cover`);
    }
  }

  // ======================================================================
  console.log("\n=== 3. A store stays due until it genuinely completes ===\n");
  // ======================================================================
  {
    // Written directly rather than by running a cycle, because what is under
    // test is the SELECTION rule reading the column — the writing of it is
    // section 2's job, and conflating the two would leave both half-proved.
    const fresh = await makeStore();
    const stale = await makeStore();
    const never = await makeStore();

    await prismaSystem.store.update({
      where: { id: fresh.id },
      data: { lastIntelligenceAt: new Date(Date.now() - 60 * 60 * 1000) },
    });
    await prismaSystem.store.update({
      where: { id: stale.id },
      data: { lastIntelligenceAt: new Date(Date.now() - 30 * 60 * 60 * 1000) },
    });

    const due = await getStoresDueForIntelligence(500);
    assert("a store evaluated an hour ago is not due", !due.includes(fresh.id));
    assert("a store evaluated 30 hours ago is due", due.includes(stale.id));
    assert("a store never evaluated is due", due.includes(never.id));
    assert("and the never-evaluated one is ordered ahead of the merely stale one",
      due.indexOf(never.id) < due.indexOf(stale.id),
      `never at ${due.indexOf(never.id)}, stale at ${due.indexOf(stale.id)}`);
  }

  // ======================================================================
  console.log("\n=== 4. An unchanged business is told nothing twice ===\n");
  // ======================================================================
  {
    // Sean: "A periodic intelligence cycle should be able to conclude 'nothing
    // changed' without creating duplicate observations, recommendations,
    // notifications, or repeated proactive speech."
    const store = await makeStore();

    await runIntelligenceCycle(store.id);
    const first = await countsFor(store.id);

    await runIntelligenceCycle(store.id);
    const second = await countsFor(store.id);

    eq("the second pass creates no further observations", second.observations, first.observations);
    eq("and resolves none of the standing ones either", second.active, first.active);
    eq("J4 says nothing a second time", second.deliveries, first.deliveries);
    eq("and writes no second message into the conversation", second.messages, first.messages);
    eq("beliefs are re-derived, not accumulated", second.beliefs, first.beliefs);
    eq("and no second batch of recommendations appears", second.outputs, first.outputs);

    // A THIRD PASS, because "twice" can hide an alternating bug that a third
    // run exposes — the first repeat is the one most likely to be special.
    await runIntelligenceCycle(store.id);
    const third = await countsFor(store.id);
    eq("a third pass is just as quiet", third, second);
  }

  // ======================================================================
  console.log("\n=== 4b. Quiet is not the same as deaf ===\n");
  // ======================================================================
  {
    // Sean: "when the underlying insight actually changes or resolves, the
    // system must still be able to record the new state correctly. Don't
    // accidentally turn deduplication into 'never update this insight again.'"
    //
    // Driven through the real persistence path rather than through a detector,
    // because what is under test is the identity rule — same topic, changed
    // wording — and a detector would only reach it if this environment happened
    // to produce that particular insight twice with different numbers.
    // THROUGH THE REAL DETECTOR, not a hand-written restatement. An earlier
    // version of this section called communicateFinding directly and asserted
    // around it, which would have passed with the dedupe deleted — the same
    // hollow shape this project has been caught by before. `inventory.depleted`
    // is used because it genuinely changes its own wording while keeping its
    // topicKey: one depleted item names that item, several report a count.
    const store = await makeStore();
    const { computeInsights } = await import("@/lib/intelligence/insights");
    const topicKey = "inventory.depleted";

    const makeItem = (itemName: string, quantityAvailable: number) =>
      prismaSystem.businessRecord.create({
        data: {
          storeId: store.id, entityType: "item", externalId: `it-${itemName}-${++seq}`,
          sourceProvider: "test", provenance: "OWNER", provenanceDetail: "suite",
          data: { name: itemName, sku: itemName, priceInCents: 1000, category: null, active: true, quantityAvailable },
        },
      });

    const activeFor = () =>
      prismaSystem.cognitiveOutput.findMany({
        where: { storeId: store.id, kind: "insight", topicKey, status: "ACTIVE" },
        select: { id: true, summary: true },
      });
    const allFor = () =>
      prismaSystem.cognitiveOutput.count({
        where: { storeId: store.id, kind: "insight", topicKey },
      });

    await makeItem("CopperRing", 0);
    await computeInsights(store.id);
    const first = await activeFor();
    eq("a first statement stands", first.length, 1);
    assert("naming the one thing that is out of stock",
      first[0].summary.includes("CopperRing"), first[0].summary);

    // ---- restated, unchanged: nothing is added ---------------------------
    const afterFirst = await allFor();
    await computeInsights(store.id);
    await computeInsights(store.id);
    eq("two further passes on unchanged data add no rows", await allFor(), afterFirst);
    eq("and leave exactly one active statement", (await activeFor()).length, 1);

    // ---- the insight genuinely changes -----------------------------------
    //
    // A second item runs out. Same topicKey, materially different sentence,
    // and the owner must be told the new state.
    await makeItem("BrassRing", 0);
    await computeInsights(store.id);

    const nowActive = await activeFor();
    eq("a changed insight leaves exactly one active statement", nowActive.length, 1);
    assert("and it is the new one", nowActive[0].summary.includes("2 items"), nowActive[0].summary);
    assert("the old statement is no longer active",
      nowActive[0].id !== first[0].id, "the stale sentence is still standing");
    eq("the superseded one is kept as history, not deleted", await allFor(), afterFirst + 1);
    eq("and is marked superseded",
      await prismaSystem.cognitiveOutput.count({
        where: { storeId: store.id, topicKey, status: "SUPERSEDED" },
      }), 1);
  }

  // ======================================================================
  console.log("\n=== 5. The AI review is not re-run by a periodic cycle ===\n");
  // ======================================================================
  {
    // The gate is `ExecutionLog`: the last SUCCESS of the recommendation
    // action within STALE_REVIEW_MS, plus a 5-minute PENDING claim. It is
    // shared with the owner-attended path, so a page visit and a scheduled
    // cycle cooperate instead of both paying.
    const store = await makeStore();
    const { EXECUTION_ACTIONS } = await import("@/lib/execution/actions");

    const attempts = () =>
      prismaSystem.executionLog.count({
        where: { storeId: store.id, action: EXECUTION_ACTIONS.GENESIS_RECOMMENDATIONS_GENERATE },
      });

    await runIntelligenceCycle(store.id);
    const afterFirst = await attempts();
    await runIntelligenceCycle(store.id);
    await runIntelligenceCycle(store.id);
    const afterThird = await attempts();

    eq("two further cycles inside the window add no further review attempts",
      afterThird, afterFirst);
    assert("and the gate is a real 24-hour window, not a per-process flag",
      (await import("node:fs")).readFileSync("lib/dashboard/genesisObservations.ts", "utf8")
        .includes("const STALE_REVIEW_MS = 24 * 60 * 60 * 1000"),
      "the staleness constant is no longer 24 hours");
  }

  // ======================================================================
  console.log("\n=== 6. One store failing does not stop the others ===\n");
  // ======================================================================
  {
    // Sean: "One store failing its cycle cannot prevent the remaining due
    // stores from being evaluated."
    //
    // The failure is real rather than mocked: a store row deleted after it was
    // selected. Every stage that reads it then throws, which is exactly the
    // shape of the disappearance a live pass has to survive.
    const doomed = await makeStore("Doomed");
    const survivors = [await makeStore("After One"), await makeStore("After Two")];

    await prismaSystem.store.update({
      where: { id: doomed.id },
      data: { lastIntelligenceAt: new Date(Date.now() - 90 * 60 * 60 * 1000) },
    });
    for (const s of survivors) {
      await prismaSystem.store.update({
        where: { id: s.id },
        data: { lastIntelligenceAt: new Date(Date.now() - 80 * 60 * 60 * 1000) },
      });
    }

    // Oldest first, so the doomed store is ahead of the survivors — the order
    // that actually tests the property. Selected while it still exists, then
    // removed before the batch runs.
    const due = await getStoresDueForIntelligence(500);
    assert("the doomed store is ordered ahead of the survivors",
      survivors.every((s) => due.indexOf(doomed.id) < due.indexOf(s.id)),
      JSON.stringify(due.slice(0, 5)));

    await prismaSystem.user.deleteMany({ where: { email: `cad-${stamp}-${seq - 2}@example.test` } });

    const batch = await runDueIntelligenceCycles(500);
    const reached = new Set(batch.summaries.map((s) => s.storeId));
    for (const s of survivors) {
      assert(`${s.name} was still evaluated`, reached.has(s.id),
        "a store ahead of it in the queue took the pass down with it");
    }
    assert("the batch reports what it was given and what it did",
      batch.due >= batch.processed && batch.processed === batch.summaries.length,
      JSON.stringify({ due: batch.due, processed: batch.processed }));
  }

  // ======================================================================
  console.log("\n=== 7. The deadline stops the pass, and says so ===\n");
  // ======================================================================
  {
    // A pass that ran out of time and a pass that found nothing must never
    // look alike — the same distinction the scheduler itself is built on.
    const store = await makeStore();
    // Held in a variable rather than recomputed at assertion time — the first
    // version compared against a freshly-computed `Date.now() - 100h` and
    // failed by three milliseconds, which is a bug in the test and not in the
    // thing it was measuring.
    const setTo = new Date(Date.now() - 100 * 60 * 60 * 1000);
    await prismaSystem.store.update({
      where: { id: store.id },
      data: { lastIntelligenceAt: setTo },
    });

    // A deadline already in the past: nothing should be started at all.
    const stopped = await runDueIntelligenceCycles(500, { deadlineAt: Date.now() - 1 });
    assert("an expired deadline processes nobody", stopped.processed === 0, JSON.stringify(stopped));
    assert("and says it stopped early rather than reporting an empty pass",
      stopped.stoppedEarly === true, JSON.stringify(stopped));
    assert("while still reporting how many were actually due",
      stopped.due > 0, JSON.stringify(stopped));

    // AND THE STORES IT DID NOT REACH KEEP THEIR PLACE. This is what makes a
    // shortened pass safe: the remainder is first in line next time.
    eq("a store the deadline skipped is not marked evaluated",
      (await lastAt(store.id))?.getTime(), setTo.getTime());
  }

  console.log(`\n${failures} failed, ${passes} passed`);
  if (failed.length > 0) {
    console.log("\nFailures:");
    for (const f of failed) console.log(`  ${f}`);
  }
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prismaSystem.$disconnect();
  });
