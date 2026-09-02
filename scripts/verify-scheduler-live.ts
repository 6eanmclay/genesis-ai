import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";

// CHAPTER 1's SCHEDULER — who is due, and what one bad row can do:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-scheduler-live.ts" -OutFile out.txt
//
// The cadence every unattended capability rides on: connector syncs, the
// intelligence cycle, Growth Point refreshes, sourcing. Its selection and its
// backoff had no coverage.
//
// TWO PROPERTIES DECIDE WHETHER A BOUNDED SCHEDULER IS HONEST.
//
// It must WORK THROUGH A BACKLOG rather than revisiting the same head of the
// queue — a limit is only safe if the ordering makes progress. Syncs order by
// due date, oldest first; intelligence orders by largest backlog first with a
// deterministic tie-break, and a processed store's lag returns to zero so it
// yields to others rather than starving them.
//
// And ONE BAD ROW MUST NOT HOLD THE QUEUE. Both loops isolate per store,
// because a cross-tenant loop that aborts on the first throw silently abandons
// every store behind it until the next invocation.
//
// A THIRD THING THE BACKOFF GETS RIGHT, and it is the subtlest: a rate limit is
// not a failure. A throttled connector ANSWERED — it just asked us to come back
// later — so counting it as a failure walks a popular connection up the
// exponential curve toward the 24h cap while nothing is wrong with it, and the
// owner sees a connection that "stopped syncing".

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

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

async function main() {
  const db = await startRealPostgres();
  await db.prisma.$disconnect();

  process.env[TEST_DATABASE_ENV] = "1";
  process.env.DATABASE_URL = db.url;

  const { nextSyncAttempt, getDueSyncs } = await import("@/lib/intelligence/scheduler");
  const { selectDueStoreIds, getStoresDueForIntelligence, runDueIntelligenceCycles } = await import(
    "@/lib/intelligence/cycle"
  );
  const { prismaSystem: prisma } = await import("@/lib/prisma");

  const NOW = 1_700_000_000_000;

  // ==========================================================================
  console.log("\n=== 1. A rate limit is not a failure ===\n");
  // ==========================================================================
  const success = nextSyncAttempt({ outcome: "success", failureCount: 4, now: NOW });
  check("success clears the failure streak", success.syncFailureCount, 0);
  check("and comes back on the ordinary interval", success.nextSyncDueAt.getTime() - NOW, 6 * HOUR);

  // THE ONE THAT MATTERS. A throttled connector answered.
  const throttled = nextSyncAttempt({
    outcome: "rate_limited", retryAfterMs: 30_000, failureCount: 3, now: NOW,
  });
  check("a rate limit leaves the failure count exactly as it was", throttled.syncFailureCount, 3);
  assert("neither cleared, because it does not prove the connection works",
    throttled.syncFailureCount === 3);
  check("and honours the provider's own timing", throttled.nextSyncDueAt.getTime() - NOW, 30_000);

  const throttledNoHint = nextSyncAttempt({ outcome: "rate_limited", failureCount: 0, now: NOW });
  check("with no timing given, a short wait rather than a whole cycle",
    throttledNoHint.nextSyncDueAt.getTime() - NOW, 5 * MINUTE);

  // A real failure walks up the curve, and stops at the cap.
  const firstFailure = nextSyncAttempt({ outcome: "failure", failureCount: 0, now: NOW });
  check("the first failure counts", firstFailure.syncFailureCount, 1);
  check("and backs off", firstFailure.nextSyncDueAt.getTime() - NOW, 12 * HOUR);
  const capped = nextSyncAttempt({ outcome: "failure", failureCount: 20, now: NOW });
  check("a long streak is capped at a day, not doubled forever",
    capped.nextSyncDueAt.getTime() - NOW, 24 * HOUR);
  // An absurd provider hint cannot push past the cap either.
  const absurdHint = nextSyncAttempt({
    outcome: "rate_limited", retryAfterMs: 90 * 24 * HOUR, failureCount: 0, now: NOW,
  });
  check("and a provider asking for three months is capped too",
    absurdHint.nextSyncDueAt.getTime() - NOW, 24 * HOUR);

  // ==========================================================================
  console.log("\n=== 2. Who is due to sync, and in what order ===\n");
  // ==========================================================================
  const owner = await prisma.user.create({ data: { email: "sched@example.test" } });
  let n = 0;
  const makeStore = (name: string) =>
    prisma.store.create({
      data: {
        userId: owner.id, name, slug: `${name.toLowerCase().replace(/[^a-z]+/g, "-")}-${++n}`,
        tagline: "t", description: "d", currency: "USD",
      },
    });

  const overdue = await makeStore("Overdue Store");
  const soon = await makeStore("Soon Store");
  const future = await makeStore("Future Store");
  const never = await makeStore("Never Synced Store");
  const broken = await makeStore("Disconnected Store");

  const integration = (storeId: string, provider: string, dueAt: Date | null, status = "CONNECTED") =>
    prisma.storeIntegration.create({
      data: { storeId, provider: provider as never, status: status as never, nextSyncDueAt: dueAt },
    });

  await integration(overdue.id, "STRIPE", new Date(Date.now() - 5 * HOUR));
  await integration(soon.id, "PAYPAL", new Date(Date.now() - 1 * MINUTE));
  await integration(future.id, "MAILCHIMP", new Date(Date.now() + 3 * HOUR));
  await integration(never.id, "QUICKBOOKS", null);
  // Disconnected: never due, however overdue its date looks.
  await integration(broken.id, "GOOGLE_CALENDAR", new Date(Date.now() - 99 * HOUR), "DISCONNECTED");

  const due = await getDueSyncs(50);
  const dueStoreIds = due.map((d) => d.storeId);

  assert("an overdue connector is due", dueStoreIds.includes(overdue.id));
  assert("a just-due one is too", dueStoreIds.includes(soon.id));
  assert("one that has never synced is due", dueStoreIds.includes(never.id), "a null date is due, not skipped");
  assert("one not due yet is not", !dueStoreIds.includes(future.id));
  assert("and a DISCONNECTED integration is never due",
    !dueStoreIds.includes(broken.id), "however overdue its date looks");

  // Oldest first, so a bounded run works through the backlog rather than
  // revisiting whoever happens to sort first.
  check("the most overdue comes before the least",
    dueStoreIds.indexOf(overdue.id) < dueStoreIds.indexOf(soon.id), true);

  const bounded = await getDueSyncs(2);
  check("the limit is respected", bounded.length, 2);
  assert("and it takes the most overdue first",
    bounded.map((b) => b.storeId).includes(overdue.id), "a limit must not starve the oldest");

  // ==========================================================================
  console.log("\n=== 3. Who is due for intelligence — largest backlog first ===\n");
  // ==========================================================================
  const activity = [
    { storeId: "small", maxSequence: BigInt(10) },
    { storeId: "large", maxSequence: BigInt(100) },
    { storeId: "caught-up", maxSequence: BigInt(50) },
    { storeId: "never-run", maxSequence: BigInt(7) },
  ];
  const cursors = [
    { storeId: "small", lastProcessedSequence: BigInt(8) },
    { storeId: "large", lastProcessedSequence: BigInt(20) },
    { storeId: "caught-up", lastProcessedSequence: BigInt(50) },
  ];

  // large is 80 behind, never-run is 7 behind (its whole history, since no
  // cursor exists), small is 2 behind.
  check("the biggest backlog goes first",
    selectDueStoreIds(activity, cursors, { limit: 10 }), ["large", "never-run", "small"]);
  assert("a store with nothing new is not due",
    !selectDueStoreIds(activity, cursors, { limit: 10 }).includes("caught-up"),
    "its cursor has caught up with its events");
  check("a store that has never run counts its whole history as backlog",
    selectDueStoreIds([{ storeId: "never-run", maxSequence: BigInt(7) }], [], { limit: 10 }),
    ["never-run"]);

  // Equal backlogs tie-break deterministically, so the same inputs always give
  // the same order — a scheduler that reshuffled would be unreproducible.
  const tied = [
    { storeId: "bbb", maxSequence: BigInt(5) },
    { storeId: "aaa", maxSequence: BigInt(5) },
  ];
  check("equal backlogs are ordered deterministically",
    selectDueStoreIds(tied, [], { limit: 10 }), ["aaa", "bbb"]);
  check("and the same call gives the same answer again",
    selectDueStoreIds(tied, [], { limit: 10 }), ["aaa", "bbb"]);

  check("the limit bounds it", selectDueStoreIds(activity, cursors, { limit: 1 }), ["large"]);
  check("a zero limit selects nobody", selectDueStoreIds(activity, cursors, { limit: 0 }), []);
  // skipStoreIds is how the cron pass avoids running a store twice when a
  // connector sync already ran its cycle.
  check("an already-handled store is skipped",
    selectDueStoreIds(activity, cursors, { limit: 10, skipStoreIds: ["large"] }),
    ["never-run", "small"]);

  // ==========================================================================
  console.log("\n=== 4. The same selection, against real rows ===\n");
  // ==========================================================================
  const busy = await makeStore("Busy Store");
  const quiet = await makeStore("Quiet Store");

  const event = (storeId: string) =>
    prisma.businessEvent.create({
      data: {
        storeId, entityType: "item", eventType: "item.updated", recordId: null,
        sourceProvider: "genesis", summary: "s",
      },
    });

  await event(busy.id);
  await event(busy.id);
  await event(quiet.id);

  const dueForIntelligence = await getStoresDueForIntelligence(50);
  assert("a store with unconsumed events is due", dueForIntelligence.includes(busy.id));
  assert("and so is the quieter one", dueForIntelligence.includes(quiet.id));

  // Once its cursor catches up, it is no longer due — the mechanism that stops
  // the scheduler from reprocessing the same events forever.
  const busyMax = await prisma.businessEvent.aggregate({
    where: { storeId: busy.id }, _max: { sequence: true },
  });
  await prisma.businessEventCursor.create({
    data: {
      storeId: busy.id,
      consumerName: "insight-engine",
      lastProcessedSequence: busyMax._max.sequence!,
    },
  });
  const afterCursor = await getStoresDueForIntelligence(50);
  assert("a caught-up store drops out", !afterCursor.includes(busy.id));
  assert("while the one still behind stays", afterCursor.includes(quiet.id));

  // ==========================================================================
  console.log("\n=== 5. One failing store does not hold the queue ===\n");
  // ==========================================================================
  // THE ISOLATION PROPERTY, DEMONSTRATED WITHOUT FORCING IT. This environment
  // has no AI provider credentials, so runIntelligenceCycle genuinely throws at
  // its Reason stage for every store. That is exactly the shape the per-store
  // try/catch exists for: before it, one store's throw abandoned every store
  // behind it in the same run, silently, until the next cron invocation.
  //
  // So the assertion is not "these succeed" — none of them can here. It is that
  // EVERY selected store still produces a summary, and every failure is
  // reported as a failure rather than swallowed.
  const first = await makeStore("Queue First");
  const second = await makeStore("Queue Second");
  const third = await makeStore("Queue Third");
  await event(first.id);
  await event(second.id);
  await event(third.id);

  const selected = await getStoresDueForIntelligence(50);
  assert("all three are selected",
    [first.id, second.id, third.id].every((id) => selected.includes(id)));

  // The batch now reports due/processed alongside the per-store summaries, so
  // a pass stopped by a deadline is distinguishable from one that found little.
  const batch = await runDueIntelligenceCycles(50);
  const summaries = batch.summaries;
  const reported = new Set(summaries.map((s) => s.storeId));
  assert("every selected store produced a summary",
    [first.id, second.id, third.id].every((id) => reported.has(id)),
    "one throw must not abandon the stores behind it");
  assert("a failed pass is reported as failed, not as an empty success",
    summaries.filter((s) => [first.id, second.id, third.id].includes(s.storeId)).every((s) => s.ok === false),
    "the provider is unreachable in this environment, and that is said plainly");
  check("a failed pass claims no insights",
    summaries.filter((s) => s.storeId === first.id).map((s) => s.insights), [0]);

  // WHAT A FAILED PASS ACTUALLY LEAVES BEHIND. The cursor belongs to the
  // Insight Engine, and computeInsights advances it once it has processed its
  // events — before the AI stage that throws here. So a failed pass does NOT
  // rewind: those events really were consumed by the consumer that owns the
  // cursor, and what failed was a later stage owning no cursor of its own.
  //
  // This corrected a comment in cycle.ts that claimed the opposite.
  check("the insight engine's cursor DID advance, because it finished its work",
    await prisma.businessEventCursor.count({ where: { storeId: first.id } }), 1);
  assert("so the store is no longer due for the same events",
    !(await getStoresDueForIntelligence(50)).includes(first.id),
    "a failed pass means the pass did not complete, never that nothing happened");

  // A store deleted between selection and execution simply stops being due —
  // its events cascade with it, so there is nothing left to process.
  const doomed = await makeStore("Doomed Store");
  await event(doomed.id);
  assert("it is due while it exists", (await getStoresDueForIntelligence(50)).includes(doomed.id));
  await prisma.store.delete({ where: { id: doomed.id } });
  assert("and drops out once deleted, rather than throwing forever",
    !(await getStoresDueForIntelligence(50)).includes(doomed.id),
    "its events cascade with it");

  // ==========================================================================
  console.log("\n=== 6. Selection is cross-tenant by design, never cross-tenant by accident ===\n");
  // ==========================================================================
  // getDueSyncs deliberately spans every store on the platform — that is the
  // question it exists to answer. What must never happen is one store's row
  // carrying another's storeId.
  const stranger = await prisma.user.create({ data: { email: "sched-stranger@example.test" } });
  const theirs = await prisma.store.create({
    data: {
      userId: stranger.id, name: "Stranger Store", slug: `stranger-${++n}`,
      tagline: "t", description: "d", currency: "USD",
    },
  });
  await integration(theirs.id, "STRIPE", new Date(Date.now() - 2 * HOUR));

  const all = await getDueSyncs(50);
  assert("another account's due connector is included, because this is platform-wide",
    all.some((i) => i.storeId === theirs.id));
  assert("and every row carries its OWN store",
    all.every((i) => typeof i.storeId === "string" && i.storeId.length > 0));
  const byStore = new Map(all.map((i) => [i.id, i.storeId]));
  for (const row of all) {
    const real = await prisma.storeIntegration.findUniqueOrThrow({
      where: { id: row.id }, select: { storeId: true },
    });
    if (byStore.get(row.id) !== real.storeId) {
      assert("a selected row's storeId matches the database", false, row.id);
    }
  }
  assert("every selected row's storeId matches the database", true);

  await prisma.$disconnect();
  await db.close();

  console.log(`\n${failures === 0 ? "All scheduler assertions passed." : `${failures} assertion(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
