import { readdirSync } from "fs";
import { runLanesInOrder, suiteNameFrom, type Lane, type LaneResult } from "@/scripts/run-all-suites";
import {
  httpLane,
  needsDatabase,
  isCodeOnly,
  isCodeOnlyWithLiveModel,
  ownDatabaseLane,
  unclaimedSuites,
  PERMANENTLY_EXCLUDED,
  SCRIPTS_DIR,
} from "@/scripts/lib/suiteLanes";

// ONE COMMAND HAS TO MEAN THE WHOLE THING:
//
//   npx tsx scripts/run-code-suites.ts run-all-suites
//
// ============ WHY THESE INJECT A RUNNER ==============================
//
// The orchestrator's real job takes twenty-five minutes, and a test that runs
// it for real could not be part of the regression it orchestrates. So the
// sequencing is a function taking an `exec`, and these hand it a fake that
// records when each lane started and finished. That proves the ORDERING
// properties — sequential, halt-on-failure, exit composition — which are the
// ones that can regress silently.
//
// The arithmetic properties are checked against the real lane authority, not
// a fake: a tally that cannot double-count is only worth asserting about the
// real partition.

let passes = 0;
let failures = 0;
const failed: string[] = [];

function assert(name: string, ok: boolean, detail = ""): void {
  if (ok) passes++;
  else { failures++; failed.push(name); }
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  assert(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const lane = (key: string): Lane => ({
  key,
  label: key,
  runner: `run-${key}-suites.ts`,
  count: () => 0,
  tally: new RegExp(`(\\d+)/(\\d+) ${key} suites pass`),
});

const result = (over: Partial<LaneResult> = {}): LaneResult => ({
  ok: true, reported: [], failed: [], passed: 0, total: 0, seconds: 0, ...over,
});

const quiet = () => {};

async function main(): Promise<void> {
  // ======================================================================
  console.log("\n=== 1. The lanes run one at a time, in order ===\n");
  // ======================================================================
  //
  // The specific mistake this file exists after: two lanes at once, sixty-two
  // embedded Postgres servers competing, and two suites reported as failures
  // that passed perfectly well alone.
  {
    const lanes = [lane("a"), lane("b"), lane("c"), lane("d")];
    const order: string[] = [];
    let inFlight = 0;
    let everConcurrent = false;

    await runLanesInOrder(lanes, async (l) => {
      inFlight++;
      if (inFlight > 1) everConcurrent = true;
      order.push(l.key);
      // A real yield, so an implementation using Promise.all would interleave
      // here and be caught rather than accidentally serialised by speed.
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return result();
    }, quiet);

    eq("every lane ran, in the order given", order, ["a", "b", "c", "d"]);
    assert("and never two at once", !everConcurrent,
      "Promise.all here is the bug this whole file was written after");
  }

  // ======================================================================
  console.log("\n=== 2. A required failure halts the run ===\n");
  // ======================================================================
  {
    const lanes = [lane("a"), lane("b"), lane("c")];
    const ran: string[] = [];
    const { results, halted } = await runLanesInOrder(lanes, async (l) => {
      ran.push(l.key);
      return l.key === "a"
        ? result({ ok: false, reported: ["something-real"], failed: ["something-real"] })
        : result();
    }, quiet);

    eq("the lane after a failure never starts", ran, ["a"]);
    eq("and the run reports where it stopped", halted?.key, "a");
    eq("with only that lane's result", [...results.keys()], ["a"]);
  }

  // ======================================================================
  console.log("\n=== 3. An ACCEPTED failure does not halt, and is not a pass ===\n");
  // ======================================================================
  //
  // Three suites fail today by decisions that are written down. Halting on
  // them would make this command permanently red and therefore ignored; but
  // they must never be counted as passing either, which the tally does by
  // printing them on their own line.
  {
    const lanes = [lane("a"), lane("b")];
    const ran: string[] = [];
    const { halted } = await runLanesInOrder(lanes, async (l) => {
      ran.push(l.key);
      return l.key === "a"
        ? result({ ok: false, reported: ["rooms"], failed: ["rooms"] })
        : result();
    }, quiet);

    eq("an accepted failure lets the run continue", ran, ["a", "b"]);
    eq("and nothing is reported as halted", halted, null);

    // AND THE CONTROL: an unaccepted suite with a similar name still halts,
    // so the acceptance is by exact name rather than by looking roughly right.
    const ran2: string[] = [];
    await runLanesInOrder([lane("a"), lane("b")], async (l) => {
      ran2.push(l.key);
      return l.key === "a"
        ? result({ ok: false, reported: ["rooms-extra"], failed: ["rooms-extra"] })
        : result();
    }, quiet);
    eq("a name merely resembling an accepted one still halts", ran2, ["a"]);
  }

  // ======================================================================
  console.log("\n=== 4. A failure in a LATER lane still fails the run ===\n");
  // ======================================================================
  //
  // The direction that would be easy to get wrong: three green lanes then a
  // red one, and a naive overall verdict taking the last thing it saw or the
  // majority.
  {
    const lanes = [lane("a"), lane("b"), lane("c"), lane("d")];
    const { results, halted } = await runLanesInOrder(lanes, async (l) =>
      l.key === "d"
        ? result({ ok: false, reported: ["late-breaker"], failed: ["late-breaker"] })
        : result({ reported: [`${l.key}-suite`], passed: 1, total: 1 }),
    quiet);

    eq("it halts on the last lane", halted?.key, "d");
    const anyFailed = [...results.values()].some((r) => r.failed.length > 0);
    assert("and a failure anywhere is a failure overall", anyFailed);
    assert("which the earlier green lanes cannot hide",
      [...results.values()].filter((r) => r.failed.length === 0).length === 3);
  }

  // ======================================================================
  console.log("\n=== 5. The tally cannot double-count or omit ===\n");
  // ======================================================================
  //
  // Against the REAL lane authority, because that is what the number claims
  // to describe.
  {
    const suites = readdirSync(SCRIPTS_DIR).filter((f) => f.startsWith("verify-") && f.endsWith(".ts"));
    const buckets = {
      browser: suites.filter((f) => httpLane(f) === "browser"),
      http: suites.filter((f) => httpLane(f) !== null && httpLane(f) !== "browser"),
      db: suites.filter((f) => httpLane(f) === null && needsDatabase(f)),
      code: suites.filter(isCodeOnly),
      live: suites.filter(isCodeOnlyWithLiveModel),
      own: suites.filter(ownDatabaseLane),
    };
    const assigned = Object.values(buckets).reduce((n, b) => n + b.length, 0)
      + Object.keys(PERMANENTLY_EXCLUDED).length;

    eq("nothing is unclaimed", unclaimedSuites(), []);
    eq("and the lanes add up to exactly what is on disk", assigned, suites.length);

    // NO SUITE IN TWO BUCKETS. The counts adding up would still permit one
    // suite counted twice and another missed entirely.
    const seen = new Map<string, string>();
    const twice: string[] = [];
    for (const [name, files] of Object.entries(buckets)) {
      for (const f of files) {
        if (seen.has(f)) twice.push(`${f} (${seen.get(f)} + ${name})`);
        seen.set(f, name);
      }
    }
    eq("and no suite is in two lanes", twice, []);
    eq("so every suite on disk is accounted for exactly once",
      seen.size + Object.keys(PERMANENTLY_EXCLUDED).length, suites.length);

    console.log(`  NOTE  ${suites.length} discovered: ${buckets.code.length} code, ${buckets.http.length} http, ` +
      `${buckets.db.length} db, ${buckets.own.length} own-db, ${buckets.browser.length} browser, ` +
      `${buckets.live.length} live-model, ${Object.keys(PERMANENTLY_EXCLUDED).length} excluded`);
  }

  // ======================================================================
  console.log("\n=== 6. It reads each runner's own tally, not its exit code ===\n");
  // ======================================================================
  //
  // Two of the four exit 0 with failures, on purpose. Parsing their lines is
  // the only way a failure there still counts, so the parser is pinned.

  eq("a plain lane line", suiteNameFrom("PASS  account-closure-db"), "account-closure-db");
  eq("a failing one", suiteNameFrom("FAIL  test-isolation"), "test-isolation");
  eq("the own-database lane's numbered form",
    suiteNameFrom("FAIL  [12/62]  scheduler-live  (11s)"), "scheduler-live");
  eq("the http lane's filename form",
    suiteNameFrom("PASS  verify-checkout-e2e.ts  (25s)"), "checkout-e2e");
  eq("a summary line is not a suite", suiteNameFrom("94/96 code-only suites pass. (185s)"), null);
  eq("nor is prose", suiteNameFrom("Running 96 code-only suites."), null);
  eq("nor a PASS inside a sentence", suiteNameFrom("  the check did PASS  eventually"), null);

  // THE ONE THAT ACTUALLY BIT. A runner prints its verdict at column zero and
  // the suite's own output INDENTED beneath it — and that output has its own
  // PASS/FAIL lines. Trimming first turned this assertion inside verify-rooms
  // into a suite named "and", which both invented a suite and double-counted
  // a real one. A full orchestrator run halted on it.
  eq("an indented assertion from inside a suite is not a suite",
    suiteNameFrom("        FAIL  and they are the rooms Sean locked"), null);
  eq("nor an indented PASS",
    suiteNameFrom("        PASS  J4 is not one of them"), null);
  eq("while the runner's own line, at column zero, still parses",
    suiteNameFrom("FAIL  rooms"), "rooms");

  console.log(`\n${failures} failed, ${passes} passed`);
  if (failed.length > 0) {
    console.log("\nFailures:");
    for (const f of failed) console.log(`  ${f}`);
  }
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
