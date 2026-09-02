import { selectDueStoreIds } from "@/lib/intelligence/cycle";

// Business Intelligence Engine M1 — the selection semantics, proved against
// engineered inputs rather than whatever a live database happens to contain.
//
// The two claims that matter, in Sean's words: a real first-party
// BusinessEvent can enter the cycle, and "an already-consumed event is not
// processed again." Both are decided here, in selectDueStoreIds — the cursor
// comparison IS the no-reprocessing guarantee, so this is the right place to
// hold it to account, and it needs no database to do it.
//
// Runs with no environment and no connection: `npx tsx scripts/verify-intelligence-selection.ts`

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${e}\n        actual   ${a}`);
}

const LIMIT = { limit: 50 };

// 1. A store with real first-party activity and no cursor row yet is due.
//    This is the M1 case: a store that has never been processed at all,
//    because it has no connector and nothing ever ran for it.
check(
  "a store with events and no cursor is due",
  selectDueStoreIds([{ storeId: "store_new", maxSequence: BigInt(3) }], [], LIMIT),
  ["store_new"]
);

// 2. A store whose cursor has caught up is NOT due. The same events must not
//    be picked up a second time.
check(
  "fully consumed events are not reprocessed",
  selectDueStoreIds(
    [{ storeId: "store_caught_up", maxSequence: BigInt(7) }],
    [{ storeId: "store_caught_up", lastProcessedSequence: BigInt(7) }],
    LIMIT
  ),
  []
);

// 3. The full two-pass sequence, which is the real-world shape of claim two:
//    due -> processed -> not due, with no new activity in between.
const activityBefore = [{ storeId: "store_a", maxSequence: BigInt(4) }];
const firstPass = selectDueStoreIds(activityBefore, [], LIMIT);
check("first pass selects the store", firstPass, ["store_a"]);
const secondPass = selectDueStoreIds(activityBefore, [{ storeId: "store_a", lastProcessedSequence: BigInt(4) }], LIMIT);
check("second pass over the same events selects nothing", secondPass, []);

// 4. ...and genuinely new activity makes it due again, so consumption is a
//    high-water mark rather than a permanent mute.
check(
  "a new event after consumption makes the store due again",
  selectDueStoreIds(
    [{ storeId: "store_a", maxSequence: BigInt(5) }],
    [{ storeId: "store_a", lastProcessedSequence: BigInt(4) }],
    LIMIT
  ),
  ["store_a"]
);

// 5. A partially-consumed store is due — one unconsumed event is enough, and
//    a cursor ahead of nothing must never be read as "close enough".
check(
  "a store one event behind is due",
  selectDueStoreIds(
    [{ storeId: "store_b", maxSequence: BigInt(100) }],
    [{ storeId: "store_b", lastProcessedSequence: BigInt(99) }],
    LIMIT
  ),
  ["store_b"]
);

// 6. A store with no events at all is never selected. "Leave stores with no
//    new activity alone" means absent from the batch, not processed and
//    discarded.
check(
  "a store with no activity is never selected",
  selectDueStoreIds([], [{ storeId: "store_quiet", lastProcessedSequence: BigInt(0) }], LIMIT),
  []
);

// 7. A store the connector path already ran this invocation is skipped, so one
//    cron pass never runs the same store's cycle twice.
check(
  "a store already handled by a connector sync is skipped",
  selectDueStoreIds(
    [
      { storeId: "store_synced", maxSequence: BigInt(9) },
      { storeId: "store_first_party", maxSequence: BigInt(2) },
    ],
    [],
    { limit: 50, skipStoreIds: ["store_synced"] }
  ),
  ["store_first_party"]
);

// 8. The batch is bounded and deterministically ordered — largest backlog
//    first, so a limit truncates the least-behind store, never at random.
check(
  "the batch is bounded, largest backlog first",
  selectDueStoreIds(
    [
      { storeId: "store_small", maxSequence: BigInt(2) },
      { storeId: "store_big", maxSequence: BigInt(500) },
      { storeId: "store_mid", maxSequence: BigInt(40) },
    ],
    [],
    { limit: 2 }
  ),
  ["store_big", "store_mid"]
);

// 9. Equal backlogs order by store id, so the same inputs always produce the
//    same batch — a cron pass must be reproducible, not incidentally ordered.
check(
  "equal backlogs are ordered deterministically",
  selectDueStoreIds(
    [
      { storeId: "store_z", maxSequence: BigInt(5) },
      { storeId: "store_a", maxSequence: BigInt(5) },
    ],
    [],
    LIMIT
  ),
  ["store_a", "store_z"]
);

// 10. A cursor ahead of the highest sequence (a restored backup, a replayed
//     log) must read as "nothing new", never as negative work.
check(
  "a cursor ahead of the log is not due",
  selectDueStoreIds(
    [{ storeId: "store_odd", maxSequence: BigInt(3) }],
    [{ storeId: "store_odd", lastProcessedSequence: BigInt(10) }],
    LIMIT
  ),
  []
);

// ======================================================================
// BI Slice 1 — elapsed time is a reason to be due (2026-09-02)
// ======================================================================
//
// The rule above is fair because lag returns to zero once a store is
// processed. A store due only because a day passed has no lag to reset, so
// that argument does not carry across and the ordering had to be rebuilt on a
// property that does self-correct: oldest evaluated first.

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-09-02T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const timed = (
  evaluations: { storeId: string; lastIntelligenceAt: Date | null }[],
  limit = 50,
  activity: { storeId: string; maxSequence: bigint }[] = [],
  cursors: { storeId: string; lastProcessedSequence: bigint }[] = [],
) => selectDueStoreIds(activity, cursors, { limit, evaluations, maxAgeMs: DAY_MS, now: NOW });

// 11. A quiet store becomes due once its evaluation is a day old.
check(
  "a store evaluated 25 hours ago is due",
  timed([{ storeId: "quiet", lastIntelligenceAt: ago(25 * 60 * 60 * 1000) }]),
  ["quiet"]
);
check(
  "a store evaluated an hour ago is not",
  timed([{ storeId: "fresh", lastIntelligenceAt: ago(60 * 60 * 1000) }]),
  []
);

// 12. Never evaluated is due, and goes first — which is also what makes the
//     first run after the migration correct rather than arbitrary.
check(
  "a store that has never been evaluated is due, and sorts ahead of an old one",
  timed([
    { storeId: "old", lastIntelligenceAt: ago(3 * DAY_MS) },
    { storeId: "never", lastIntelligenceAt: null },
  ]),
  ["never", "old"]
);

// 13. Oldest first, so evaluating a store moves it to the back.
check(
  "the time-due set is ordered oldest evaluated first",
  timed([
    { storeId: "two_days", lastIntelligenceAt: ago(2 * DAY_MS) },
    { storeId: "five_days", lastIntelligenceAt: ago(5 * DAY_MS) },
    { storeId: "three_days", lastIntelligenceAt: ago(3 * DAY_MS) },
  ]),
  ["five_days", "three_days", "two_days"]
);

// 14. Something that actually happened outranks a store that is merely old.
//     A store with new events has new information; a store due only on age
//     has, by definition, nothing new to interpret.
check(
  "activity outranks age under a tight limit",
  timed(
    [{ storeId: "ancient", lastIntelligenceAt: ago(30 * DAY_MS) }],
    1,
    [{ storeId: "busy", maxSequence: BigInt(9) }],
    []
  ),
  ["busy"]
);

// 15. A store already selected for activity is not selected twice.
check(
  "a store due both ways appears once",
  timed(
    [{ storeId: "both", lastIntelligenceAt: ago(9 * DAY_MS) }],
    50,
    [{ storeId: "both", maxSequence: BigInt(4) }],
    []
  ),
  ["both"]
);

// 16. The skip list still applies to the time-based path.
check(
  "a skipped store is not selected on age either",
  selectDueStoreIds([], [], {
    limit: 50,
    evaluations: [{ storeId: "skipped", lastIntelligenceAt: null }],
    maxAgeMs: DAY_MS,
    now: NOW,
    skipStoreIds: ["skipped"],
  }),
  []
);

// 17. Omitting the elapsed-time inputs restores the old behaviour exactly.
//     A caller that does not ask for it cannot accidentally get it.
check(
  "without evaluations, only activity decides",
  selectDueStoreIds([], [], { limit: 50 }),
  []
);

// ======================================================================
// 18. THE ONE SEAN ASKED FOR: more due stores than a pass can hold
// ======================================================================
//
// "Test the behavior with more due stores than one invocation can process and
// prove that the remainder gets priority on the next run."
//
// Twelve stores, a batch of five, none ever evaluated. Each round evaluates
// what it was given — the only state change a real pass makes — and the next
// round must pick up strictly where the last one stopped. What is being proved
// is that nobody is served twice before everybody is served once, which is the
// property registry-order scheduling did not have and which no test at
// today's store count would ever exercise.
{
  const BATCH = 5;
  const stores = Array.from({ length: 12 }, (_, i) => `store_${String(i).padStart(2, "0")}`);
  const evaluated = new Map<string, Date | null>(stores.map((s) => [s, null]));

  let clock = NOW.getTime();
  const rounds: string[][] = [];
  for (let round = 0; round < 3; round++) {
    clock += 60_000;
    const at = new Date(clock);
    const due = selectDueStoreIds([], [], {
      limit: BATCH,
      evaluations: stores.map((s) => ({ storeId: s, lastIntelligenceAt: evaluated.get(s) ?? null })),
      maxAgeMs: DAY_MS,
      now: at,
    });
    rounds.push(due);
    // A COMPLETED PASS IS THE ONLY THING THAT MOVES A STORE BACK. Exactly the
    // production rule: lastIntelligenceAt is written when the cycle completes.
    for (const s of due) evaluated.set(s, at);
  }

  check("round 1 takes the first five", rounds[0], stores.slice(0, 5));
  check("round 2 takes the next five, not the first five again", rounds[1], stores.slice(5, 10));
  check("round 3 takes the remaining two", rounds[2], stores.slice(10, 12));

  const served = rounds.flat();
  check("every store was reached", [...new Set(served)].sort(), [...stores].sort());
  check("and none was served twice before all were served once", served.length, stores.length);
  check("nothing is left unevaluated", [...evaluated.values()].filter((v) => v === null).length, 0);
}

// 19. A store that never completes holds one slot, and only one.
//
//     lastIntelligenceAt is written only on a completed pass, so a store whose
//     cycle keeps failing stays due forever. That is deliberate — a failure
//     must not look like a healthy pass — and the cost is bounded: it occupies
//     a single slot per round while everyone else still advances. The bound is
//     asserted here so that "bounded" is a fact rather than a hope.
{
  const BATCH = 3;
  const stores = ["broken", "a", "b", "c", "d"];
  const evaluated = new Map<string, Date | null>(stores.map((s) => [s, null]));
  let clock = NOW.getTime();
  const rounds: string[][] = [];

  for (let round = 0; round < 3; round++) {
    clock += 60_000;
    const at = new Date(clock);
    const due = selectDueStoreIds([], [], {
      limit: BATCH,
      evaluations: stores.map((s) => ({ storeId: s, lastIntelligenceAt: evaluated.get(s) ?? null })),
      maxAgeMs: DAY_MS,
      now: at,
    });
    rounds.push(due);
    // "broken" never completes, so it is never stamped.
    for (const s of due) if (s !== "broken") evaluated.set(s, at);
  }

  check("the failing store is retried every round", rounds.every((r) => r.includes("broken")), true);
  check("and takes exactly one slot each time",
    rounds.map((r) => r.filter((s) => s === "broken").length), [1, 1, 1]);
  check("while everyone else still gets evaluated",
    [...evaluated.entries()].filter(([s, v]) => s !== "broken" && v === null).map(([s]) => s), []);
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
