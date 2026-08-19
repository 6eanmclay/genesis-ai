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

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
