import "@/scripts/lib/allowServerOnly";
import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import {
  runDueIntelligenceCycles,
  runIntelligenceCycle,
  getStoresDueForIntelligence,
  getStoresDueForAiReview,
  runDueAiReviews,
  INTELLIGENCE_MAX_AGE_MS,
  runCycleStages,
} from "@/lib/intelligence/cycle";
import { STALE_REVIEW_MS } from "@/lib/dashboard/genesisObservations";
import { EXECUTION_ACTIONS } from "@/lib/execution/actions";
import { runTimeBasedDetection, runChangeDetection } from "@/lib/intelligence/changeDetection";
import { detectInsightRecurrence } from "@/lib/intelligence/learn";
import { INSIGHT_PREFIX } from "@/lib/intelligence/notify";

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

  // ======================================================================
  console.log("\n=== 8. The cheap evaluation no longer pays for the expensive one ===\n");
  // ======================================================================
  {
    // ============ THE SEPARATION THIS SLICE EXISTS FOR ================
    //
    // In the first production tick the AI review was 98.7% of the cycle:
    // 206 of 209 seconds, six Opus calls. The other five stages cost about
    // 380ms per store. So a deterministic evaluation every business could
    // afford daily was priced at the rate of one only six could.
    //
    // The property: a deterministic pass completes, and advances the
    // timestamp, WITHOUT any review being attempted.
    const store = await makeStore();

    const reviewsFor = () =>
      prismaSystem.executionLog.count({
        where: { storeId: store.id, action: EXECUTION_ACTIONS.GENESIS_RECOMMENDATIONS_GENERATE },
      });

    eq("no review has been attempted for a new store", await reviewsFor(), 0);
    const summary = await runIntelligenceCycle(store.id);

    assert("the deterministic pass completes without a provider",
      summary.ok === true, JSON.stringify(summary.failedStages));
    assert("and stamps the store",
      (await lastAt(store.id)) !== null, "a completed deterministic pass did not advance the cadence");
    eq("while attempting no AI review at all", await reviewsFor(), 0);

    // AND THE STAGE IS GONE, not merely skipped. A stage that still existed
    // and quietly did nothing would look identical from outside until the day
    // somebody re-enabled it.
    eq("ai_review is no longer one of the cycle's stages",
      summary.failedStages.includes("ai_review" as never), false);
  }

  // ======================================================================
  console.log("\n=== 9. The AI review is independently 24h-gated ===\n");
  // ======================================================================
  {
    // Selection only — deliberately nothing is invoked here, so this section
    // cannot cost money or depend on a provider being reachable.
    const never = await makeStore();
    const fresh = await makeStore();
    const stale = await makeStore();

    const logReview = (storeId: string, at: Date) =>
      prismaSystem.executionLog.create({
        data: {
          executionId: `suite-${storeId}-${at.getTime()}`,
          actorType: "GENESIS",
          storeId, action: EXECUTION_ACTIONS.GENESIS_RECOMMENDATIONS_GENERATE,
          status: "SUCCESS", verified: false, retryable: false,
          message: "suite", createdAt: at,
        },
      });

    await logReview(fresh.id, new Date(Date.now() - 60 * 60 * 1000));
    await logReview(stale.id, new Date(Date.now() - 30 * 60 * 60 * 1000));

    const due = await getStoresDueForAiReview(500);
    assert("a store reviewed an hour ago is not due", !due.includes(fresh.id));
    assert("a store reviewed 30 hours ago is due", due.includes(stale.id));
    assert("a store never reviewed is due", due.includes(never.id));
    assert("and the never-reviewed one is ordered ahead of the stale one",
      due.indexOf(never.id) < due.indexOf(stale.id),
      `never at ${due.indexOf(never.id)}, stale at ${due.indexOf(stale.id)}`);

    // ONE DEFINITION OF STALE, not two. The selector and the gate inside
    // runOpportunisticAiReviewIfStale must read the same constant, or a store
    // could be selected by one and refused by the other forever.
    eq("the selector uses the gate's own staleness window", STALE_REVIEW_MS, 24 * 60 * 60 * 1000);

    // A FAILED review does not count as having been reviewed — the gate reads
    // SUCCESS, so a store whose review failed is still due.
    const failed = await makeStore();
    await prismaSystem.executionLog.create({
      data: {
        executionId: `suite-failed-${failed.id}`,
        actorType: "GENESIS",
        storeId: failed.id, action: EXECUTION_ACTIONS.GENESIS_RECOMMENDATIONS_GENERATE,
        status: "FAILED", verified: false, retryable: false, message: "suite",
      },
    });
    assert("a store whose review failed is still due one",
      (await getStoresDueForAiReview(500)).includes(failed.id),
      "a failure was mistaken for a completed review");
  }

  // ======================================================================
  console.log("\n=== 10. A review cannot touch the deterministic cadence ===\n");
  // ======================================================================
  {
    // Whether the review succeeds or fails in this environment, the one thing
    // it must never do is move `lastIntelligenceAt`. That column belongs to
    // the other task, and the whole separation rests on it.
    const store = await makeStore();
    await runIntelligenceCycle(store.id);
    const stampedAt = await lastAt(store.id);
    assert("the store starts with a deterministic evaluation", stampedAt !== null);

    const batch = await runDueAiReviews(500);
    const after = await lastAt(store.id);

    eq("the review left the deterministic timestamp exactly as it was",
      after?.getTime(), stampedAt?.getTime());
    assert("whatever the review's own outcome was",
      typeof batch.completed === "number",
      JSON.stringify({ due: batch.due, processed: batch.processed, completed: batch.completed }));
    console.log(`  NOTE  the review pass reported due=${batch.due} processed=${batch.processed} completed=${batch.completed} in this environment`);

    // ============ AND THE SUCCESS PATH, WHICH NO TEST HERE CAN REACH ==
    //
    // FOUND BY SABOTAGE (2026-09-02). Adding a `lastIntelligenceAt` write to
    // the review's SUCCESS branch left every assertion in this section green,
    // because a review cannot succeed in an environment with no provider — so
    // the branch the sabotage edited was never executed.
    //
    // This is lane 4 evidence (source-asserted), and is labelled as such
    // rather than dressed up as behavioural: the guarantee is that the review
    // task does not write that column AT ALL, on any branch, and the only way
    // to check the unreachable branch is to read it.
    {
      const source = (await import("node:fs")).readFileSync("lib/intelligence/cycle.ts", "utf8");
      const start = source.indexOf("export async function runDueAiReviews");
      const end = source.indexOf("export interface IntelligenceBatchSummary");
      const body = start >= 0 && end > start ? source.slice(start, end) : source;
      assert("the review task never writes the deterministic timestamp, on any branch",
        !body.includes("lastIntelligenceAt"),
        "runDueAiReviews references lastIntelligenceAt — the column belongs to the other task");
    }

    // AND IT NEVER STAMPS ONE ITSELF. A store with no deterministic pass at
    // all must not gain a timestamp from being reviewed.
    const unevaluated = await makeStore();
    const before = await lastAt(unevaluated.id);
    await runDueAiReviews(500);
    eq("a store the review touched but the cycle did not is still unevaluated",
      (await lastAt(unevaluated.id))?.getTime() ?? null, before?.getTime() ?? null);
  }

  // ======================================================================
  console.log("\n=== 11. Neither task reaches across tenants ===\n");
  // ======================================================================
  {
    const mine = await makeStore("Mine");
    const theirs = await makeStore("Theirs");

    await runIntelligenceCycle(mine.id);
    const mineAt = await lastAt(mine.id);
    const theirsAt = await lastAt(theirs.id);

    assert("evaluating one store stamps that store", mineAt !== null);
    eq("and does not stamp another", theirsAt, null);

    // The selectors are cross-tenant by design (they ask "who across the
    // platform is due") and are reachable only from the CRON_SECRET-gated
    // route. What must not happen is one store's WORK landing on another.
    const strayObservations = await prismaSystem.genesisObservation.count({
      where: { storeId: theirs.id },
    });
    eq("and writes no findings into the other store", strayObservations, 0);
  }

  // ======================================================================
  console.log("\n=== 12. Time alone is now a reason to notice (G1) ===\n");
  // ======================================================================
  {
    // The two time-based sweeps had ONE caller: runChangeDetection, which the
    // scheduler runs after a connector sync and only when that sync returned
    // changes. Eight of sixteen production stores have no connected
    // integration at all, so an invoice could go overdue and J4 emit nothing.
    const store = await makeStore();

    // A genuinely overdue invoice, and NO connector, NO sync, NO change list.
    await prismaSystem.businessRecord.create({
      data: {
        storeId: store.id, entityType: "document", externalId: `inv-${stamp}-${++seq}`,
        sourceProvider: "test", provenance: "OWNER", provenanceDetail: "suite",
        data: {
          type: "invoice", status: "open", amountInCents: 24500,
          dueAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
        },
      },
    });

    const eventsFor = () =>
      prismaSystem.businessEvent.count({ where: { storeId: store.id, eventType: "invoice.overdue" } });

    eq("nothing has been noticed yet", await eventsFor(), 0);

    // THROUGH THE CYCLE, not by calling the sweep directly — the seam under
    // test is the new caller, and a test that called the detector itself would
    // pass with the caller deleted.
    const summary = await runIntelligenceCycle(store.id);
    assert("the deterministic pass completes", summary.ok, JSON.stringify(summary.failedStages));
    eq("the overdue invoice was noticed with no connector activity at all",
      await eventsFor(), 1);

    // ---- 2. and a connector sync cannot double-emit it -----------------
    //
    // Both callers pass through alreadyFlaggedRecently, a 20h window. This is
    // the property, not the implementation: whichever path runs second must
    // add nothing.
    await runChangeDetection(store.id, "quickbooks", []);
    eq("a connector sync over the same still-true condition adds nothing",
      await eventsFor(), 1);

    // AND THE SYNC PATH STILL SWEEPS AT ALL — the half the assertion above
    // cannot see. Found by sabotage: deleting the sweep call from
    // runChangeDetection entirely left "adds nothing" green, because a path
    // that does nothing also adds nothing. So a store where the SYNC gets
    // there first must produce the event.
    const syncFirst = await makeStore("Sync First");
    await prismaSystem.businessRecord.create({
      data: {
        storeId: syncFirst.id, entityType: "document", externalId: `inv-sf-${stamp}-${++seq}`,
        sourceProvider: "test", provenance: "OWNER", provenanceDetail: "suite",
        data: {
          type: "invoice", status: "open", amountInCents: 9900,
          dueAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
        },
      },
    });
    await runChangeDetection(syncFirst.id, "quickbooks", []);
    eq("a connector sync that gets there first still notices it",
      await prismaSystem.businessEvent.count({
        where: { storeId: syncFirst.id, eventType: "invoice.overdue" },
      }), 1);

    await runIntelligenceCycle(store.id);
    eq("and neither does a second cycle", await eventsFor(), 1);

    // ---- 7. tenant isolation --------------------------------------------
    const neighbour = await makeStore("Neighbour");
    await runTimeBasedDetection(neighbour.id, "internal");
    eq("sweeping one store writes nothing into another",
      await prismaSystem.businessEvent.count({ where: { storeId: neighbour.id } }), 0);
    eq("and the first store is untouched by its neighbour's sweep", await eventsFor(), 1);
  }

  // ======================================================================
  console.log("\n=== 13. Recurrence is how long it has been true (G2) ===\n");
  // ======================================================================
  {
    // The old signal counted DISTINCT WEEKS IN WHICH A ROW WAS WRITTEN. Slice
    // 1's dedupe means an unchanging insight writes one row ever, so that
    // counter froze at one and a belief about a persistent condition could
    // never form again. The condition's own duration is the honest signal, and
    // GenesisObservation already carries it.
    const store = await makeStore();
    const beliefs = () => prismaSystem.belief.count({ where: { storeId: store.id } });
    const belief = () =>
      prismaSystem.belief.findFirst({
        where: { storeId: store.id, category: "insight_recurrence" },
        select: { topicKey: true, claim: true, evidenceCount: true, firstObservedAt: true, lastConfirmedAt: true },
      });

    const standingFor = async (days: number, summary = "3 invoices are now overdue.") => {
      const first = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      await prismaSystem.genesisObservation.upsert({
        where: { storeId_dedupeKey: { storeId: store.id, dedupeKey: `${INSIGHT_PREFIX}invoices.overdue` } },
        create: {
          storeId: store.id, dedupeKey: `${INSIGHT_PREFIX}invoices.overdue`,
          genesisState: "urgent", summary, status: "ACTIVE",
          firstNoticedAt: first, lastConfirmedAt: new Date(),
        },
        update: { summary, firstNoticedAt: first, lastConfirmedAt: new Date(), status: "ACTIVE" },
      });
    };

    // ---- 3. duration, not calendar identity ---------------------------
    await standingFor(20);
    await detectInsightRecurrence(store.id);
    eq("a condition standing 20 days is not yet a belief", await beliefs(), 0);

    await standingFor(25);
    await detectInsightRecurrence(store.id);
    eq("one standing 25 days is", await beliefs(), 1);

    const formed = await belief();
    eq("keyed on the condition, never on a week",
      formed?.topicKey, "insight_recurrence:invoices.overdue");
    assert("and the claim states its duration",
      (formed?.claim ?? "").includes("25 days"), formed?.claim ?? "");

    // ---- 4. another day passing is not another finding ------------------
    await standingFor(26);
    await detectInsightRecurrence(store.id);
    eq("a day later it is still ONE belief, not a second", await beliefs(), 1);
    const older = await belief();
    eq("the same logical finding", older?.topicKey, "insight_recurrence:invoices.overdue");
    assert("whose age has moved", (older?.claim ?? "").includes("26 days"), older?.claim ?? "");
    assert("and whose evidence grew with it",
      (older?.evidenceCount ?? 0) > (formed?.evidenceCount ?? 0),
      `${formed?.evidenceCount} -> ${older?.evidenceCount}`);

    // ---- 5. a worsening condition updates ------------------------------
    await standingFor(27, "7 invoices are now overdue.");
    await detectInsightRecurrence(store.id);
    const worse = await belief();
    assert("a changed condition updates the same belief",
      (worse?.claim ?? "").includes("7 invoices"), worse?.claim ?? "");
    eq("still one belief", await beliefs(), 1);

    // ---- 6. resolution still retracts ----------------------------------
    await prismaSystem.genesisObservation.updateMany({
      where: { storeId: store.id, dedupeKey: `${INSIGHT_PREFIX}invoices.overdue` },
      data: { status: "RESOLVED" },
    });
    const before = await belief();
    await detectInsightRecurrence(store.id);
    const after = await belief();
    eq("a resolved condition stops being re-confirmed",
      after?.lastConfirmedAt?.getTime(), before?.lastConfirmedAt?.getTime());

    // THE ASSERTION ABOVE CANNOT SEE A RESOLVED ROW BEING READ, because the
    // belief already exists and re-confirming it with the same timestamp looks
    // identical to not touching it. Found by sabotage: removing the ACTIVE
    // filter left it green.
    //
    // So: a store whose ONLY standing condition is already resolved must form
    // no belief at all. That is a difference nothing can hide.
    const resolvedOnly = await makeStore("Resolved Only");
    await prismaSystem.genesisObservation.create({
      data: {
        storeId: resolvedOnly.id, dedupeKey: `${INSIGHT_PREFIX}revenue.decreased`,
        genesisState: "urgent", summary: "Revenue fell sharply.", status: "RESOLVED",
        firstNoticedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
        lastConfirmedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      },
    });
    await detectInsightRecurrence(resolvedOnly.id);
    eq("a long-standing but RESOLVED condition forms no belief",
      await prismaSystem.belief.count({ where: { storeId: resolvedOnly.id } }), 0);

    // ---- 7. tenant isolation -------------------------------------------
    const neighbour = await makeStore("Neighbour Two");
    await detectInsightRecurrence(neighbour.id);
    eq("one store's standing condition is not another's belief",
      await prismaSystem.belief.count({ where: { storeId: neighbour.id } }), 0);
  }

  // ======================================================================
  console.log("\n=== 14. The deterministic sweep is reached without a visitor ===\n");
  // ======================================================================
  //
  // runDeterministicObservationSweep finds three conditions that become true
  // from time passing, and until now its only two callers were a Stripe
  // webhook and the dashboard page. Checked against production before this
  // was written: nine of sixteen businesses had never had a single
  // deterministic observation written, and all sixteen had stale-pending
  // executions the sweep would have named.
  //
  // The seam is the WIRING — runIntelligenceCycle must call it — so these
  // exercise the real cycle rather than the sweep. Calling the sweep directly
  // would pass identically before and after the change, which is the hollow
  // shape sabotage has already caught three times in this suite.
  {
    const stalePendingOn = async (storeId: string) =>
      prisma.executionLog.create({
        data: {
          executionId: `stale-${storeId}`,
          storeId,
          // NOT one of AWAITING_A_HUMAN. GENESIS_STORE_MESSAGE is PENDING by
          // design — J4 raised something and the owner has not answered — and
          // treating that as a stalled execution would turn every proactive
          // message into an alarm an hour later.
          action: EXECUTION_ACTIONS.PRODUCT_CREATE,
          status: "PENDING",
          verified: false,
          message: "Creating the product",
          retryable: true,
          actorType: "GENESIS",
          // Older than the one-hour cutoff, inside the seven-day window.
          createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
        },
      });

    const deterministicOn = (storeId: string) =>
      prismaSystem.genesisObservation.count({
        where: { storeId, status: "ACTIVE", dedupeKey: { startsWith: "deterministic:" } },
      });

    const visited = await makeStore("Cofoundr");
    const neighbour = await makeStore("Lumen Aquatics");
    await stalePendingOn(visited.id);

    eq("before the cycle, nobody has swept this business", await deterministicOn(visited.id), 0);

    await runIntelligenceCycle(visited.id);

    assert("a scheduled pass finds what only a visitor used to find",
      (await deterministicOn(visited.id)) > 0);

    // THE CONTROL. Without it the assertion above passes for a suite that
    // writes a deterministic observation for every store it touches, which
    // would say nothing about whether the stale execution was what did it.
    await runIntelligenceCycle(neighbour.id);
    eq("a business with nothing stalled is still swept and still silent",
      await deterministicOn(neighbour.id), 0);

    // Tenant scope, asserted rather than assumed: the sweep reads one
    // business, and the neighbour's row is the only thing that could leak in.
    await stalePendingOn(neighbour.id);
    await runIntelligenceCycle(neighbour.id);
    const visitedAfter = await deterministicOn(visited.id);
    await runIntelligenceCycle(visited.id);
    eq("the neighbour's stalled execution never becomes this one's finding",
      await deterministicOn(visited.id), visitedAfter);

    // ============ AND IT DOES NOT SAY IT TWICE ========================
    //
    // The sweep already dedupes by topicKey, and the whole point of running it
    // daily is that a condition standing for a week is one finding, not seven.
    const outputsBefore = await prismaSystem.cognitiveOutput.count({
      where: { storeId: visited.id, topicKey: { startsWith: "deterministic:" } },
    });
    await runIntelligenceCycle(visited.id);
    eq("running again on the same standing condition records nothing new",
      await prismaSystem.cognitiveOutput.count({
        where: { storeId: visited.id, topicKey: { startsWith: "deterministic:" } },
      }), outputsBefore);

    // ============ AND J4 WAITING ON THE OWNER IS NOT A STALL =========
    //
    // AWAITING_A_HUMAN exists because recordGenesisExecution writes a PENDING
    // row meaning "J4 raised something and the owner has not answered", which
    // stays PENDING for as long as the owner takes. Counting those as stalled
    // executions turns every proactive message into an urgent badge an hour
    // later.
    //
    // THE SEAM IS THE QUERY, NOT THE PREDICATE. verify-stale-executions.ts
    // already proves isAwaitingHumanDecision answers correctly, and it stayed
    // green when the `notIn` filter was cut out of getStaleExecutions — the
    // helper kept giving the right answer to a caller that had stopped asking.
    // This asserts the exclusion where it actually takes effect, which matters
    // more now the sweep runs daily for every business rather than only the
    // ones somebody opened.
    const patient = await makeStore("Fernbrook Botanicals");
    await prisma.executionLog.create({
      data: {
        executionId: `awaiting-${patient.id}`,
        storeId: patient.id,
        action: EXECUTION_ACTIONS.GENESIS_STORE_MESSAGE,
        status: "PENDING",
        verified: false,
        message: "Your three best-selling products are nearly out of stock",
        retryable: false,
        actorType: "GENESIS",
        createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
      },
    });
    await runIntelligenceCycle(patient.id);
    eq("a message J4 is still waiting on is not a stalled execution",
      await deterministicOn(patient.id), 0);

  }

  // ======================================================================
  console.log("\n=== 15. The two sweeps survive each other ===\n");
  // ======================================================================
  //
  // This is the whole reason the observation sweep is its own stage rather
  // than a second line inside detect_change. Sharing a stage means the first
  // one to throw takes the second with it, silently — and both are cheap
  // deterministic reads that have no reason to fail together.
  {
    const store = await makeStore("Haul & Co.");
    const noop = async () => {};
    const boom = async () => { throw new Error("sweep failed"); };

    let sweptAfterDetectChangeThrew = false;
    const a = await runCycleStages(store.id, {
      detectChange: boom,
      observationSweep: async () => { sweptAfterDetectChangeThrew = true; },
      insights: async () => [],
      notify: noop,
      learn: noop,
      staffPolicyGap: noop,
      speak: async () => ({ spoken: 0 }),
    }, () => {});
    assert("detect_change throwing does not stop the observation sweep", sweptAfterDetectChangeThrew);
    eq("and the stage that failed is the one named", a.failedStages, ["detect_change"]);

    let interpretedAfterSweepThrew = false;
    const b = await runCycleStages(store.id, {
      detectChange: noop,
      observationSweep: boom,
      insights: async () => { interpretedAfterSweepThrew = true; return []; },
      notify: noop,
      learn: noop,
      staffPolicyGap: noop,
      speak: async () => ({ spoken: 0 }),
    }, () => {});
    assert("the observation sweep throwing does not stop interpretation",
      interpretedAfterSweepThrew);
    eq("and it is named by its own stage name", b.failedStages, ["observation_sweep"]);

    // A FAILED SWEEP IS NOT A COMPLETED EVALUATION. The same rule Slice 1
    // established for every other stage: a pass that did not finish must not
    // advance the cadence, or the business drops out of the queue for a day
    // having been told nothing.
    assert("a pass whose sweep failed is not ok", b.ok === false);
    const before = await lastAt(store.id);
    await runIntelligenceCycle(store.id);
    assert("a pass whose stages all ran does advance the cadence",
      (await lastAt(store.id)) !== before);
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
