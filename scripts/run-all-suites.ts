import { execFile } from "child_process";
import { readdirSync } from "fs";
import {
  httpLane,
  needsDatabase,
  isCodeOnly,
  isCodeOnlyWithLiveModel,
  ownDatabaseLane,
  unclaimedSuites,
  PERMANENTLY_EXCLUDED,
  SCRIPTS_DIR,
} from "./lib/suiteLanes";

// ONE COMMAND, AND IT MEANS THE WHOLE THING.
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/run-all-suites.ts" -OutFile out.txt
//
// ============ WHY THIS EXISTS =======================================
//
// There are four runners. "Full regression" therefore meant four commands and
// four tallies read separately, and on the day the fourth lane landed I ran
// two of them AT THE SAME TIME and manufactured two failures that were pure
// process contention — sixty-two embedded Postgres servers do not share a
// laptop politely. Both suites passed alone. That is an hour lost to a
// footgun the tooling handed me.
//
// So this runs them one after another, and nothing here can run two at once.
//
// ============ WHAT THIS IS NOT ======================================
//
// It is orchestration and nothing else. It does not decide which suite is in
// which lane — scripts/lib/suiteLanes.ts is the only authority for that and is
// untouched — and it does not re-implement discovery. It asks the lane
// functions for the arithmetic, invokes the four existing runners as
// subprocesses, and adds up what they report.
//
// ============ IT CANNOT TURN A FAILURE INTO A WARNING ================
//
// Two of the four runners exit 0 even when suites fail, deliberately: the
// database and own-database lanes can fail for reasons about this machine
// rather than about the code, and a runner that exits non-zero on that teaches
// people to ignore it. That is their contract and it is not changed here.
//
// It does mean the exit code of a lane is NOT the signal. This parses each
// lane's own tally and counts the failures itself, so a lane that reports a
// failure while exiting 0 still fails the run.

/** A lane, in the order it runs. Cheapest first, so a failure halts early. */
export interface Lane {
  key: string;
  label: string;
  runner: string;
  /** Which suites this lane will execute, from the lane authority. */
  count: () => number;
  /** The tally line it prints, e.g. "94/96 code-only suites pass." */
  tally: RegExp;
}

const LANES: Lane[] = [
  {
    key: "code",
    label: "code-only (no infrastructure)",
    runner: "run-code-suites.ts",
    count: () => allSuites().filter(isCodeOnly).length,
    tally: /(\d+)\/(\d+) code-only suites pass/,
  },
  {
    key: "http",
    label: "http (real Next server)",
    runner: "run-http-suites.ts",
    count: () => allSuites().filter((f) => httpLane(f) !== null && httpLane(f) !== "browser").length,
    tally: /(\d+)\/(\d+) HTTP suites pass/,
  },
  {
    key: "db",
    label: "database-backed (shared Postgres)",
    runner: "run-db-suites.ts",
    count: () => allSuites().filter((f) => httpLane(f) === null && needsDatabase(f)).length,
    tally: /(\d+)\/(\d+) database-backed suites pass/,
  },
  {
    key: "pg",
    label: "own-database (a Postgres each, ~12 minutes)",
    runner: "run-pg-suites.ts",
    count: () => allSuites().filter(ownDatabaseLane).length,
    tally: /(\d+)\/(\d+) own-database suites pass/,
  },
];

/**
 * Suites known to fail, each by a decision somebody made on purpose.
 *
 * ============ WHY THIS IS ALLOWED TO EXIST ==========================
 *
 * Without it this command is red forever and therefore worthless: three
 * suites fail today for reasons that are recorded, owned, and NOT engineering
 * defects. Requiring them to pass would mean either lying about them or
 * quietly deleting real assertions.
 *
 * ============ AND WHY IT CANNOT BECOME A DUMPING GROUND =============
 *
 * Every entry names the decision and where it is written down. They are
 * counted and printed SEPARATELY — never folded into "passed" — so the number
 * of accepted failures is always on screen. And an entry that starts passing
 * is REPORTED as stale, because a suppression list nobody prunes is how a
 * real failure eventually hides behind an old excuse.
 */
const ACCEPTED_FAILURES: Record<string, string> = {
  "test-isolation": "pre-existing; Sean: leave the 51/52 test-isolation issue untouched",
  rooms: "EXTERNAL_BLOCKERS.md E25 — five primary tabs against a rooms model locked at four; Sean's decision, and editing the lock to match the code is what must not happen",
  "store-currency": "EXTERNAL_BLOCKERS.md E26 — hardcoded $ in the Creation Station, which is the Studio reference implementation and out of scope here",
};

function allSuites(): string[] {
  return readdirSync(SCRIPTS_DIR).filter((f) => f.startsWith("verify-") && f.endsWith(".ts"));
}

/**
 * "FAIL  [12/62]  scheduler-live  (11s)" and friends -> "scheduler-live".
 *
 * ============ COLUMN ZERO IS THE WHOLE RULE =======================
 *
 * Every runner prints its per-suite verdict at the start of a line and any
 * detail INDENTED beneath it. That detail is the suite's own output, which
 * contains its own PASS/FAIL lines — so trimming first and then matching
 * picked up assertions from INSIDE a suite as if they were suites.
 *
 * It was not theoretical. A full run halted claiming a required failure in
 * a suite called "and", parsed out of
 *
 *     FAIL  and they are the rooms Sean locked
 *
 * which is one assertion inside verify-rooms. That both invented a suite
 * and double-counted a real one — the two things the combined tally exists
 * to make impossible. Found by running the orchestrator end to end against
 * a deliberately broken lane, not by reading it.
 */
export function suiteNameFrom(line: string): string | null {
  const match = line.match(/^(?:PASS|FAIL)  (?:\[\s*\d+\/\d+\]\s+)?(\S+)/);
  if (!match) return null;
  return match[1].replace(/^verify-/, "").replace(/\.ts$/, "");
}

export interface LaneResult {
  ok: boolean;
  /** Every suite the lane reported on, PASS or FAIL. */
  reported: string[];
  failed: string[];
  /** From the lane's own tally line, so this cannot disagree with it. */
  passed: number;
  total: number;
  seconds: number;
}

/**
 * Run the lanes IN ORDER, stopping at the first one with a required failure.
 *
 * SEPARATED FROM THE SPAWNING so the sequencing itself can be tested without
 * twenty-five minutes of real suites: the caller supplies `exec`. That is the
 * only reason this is a parameter — the real main() passes a subprocess
 * runner and nothing else ever will.
 *
 * `await` in a `for` loop is the whole mechanism. There is no Promise.all here
 * and there must never be one: two lanes at once is the specific mistake this
 * file was written after.
 */
export async function runLanesInOrder(
  lanes: Lane[],
  exec: (lane: Lane) => Promise<LaneResult>,
  log: (line: string) => void = console.log
): Promise<{ results: Map<string, LaneResult>; halted: Lane | null }> {
  const results = new Map<string, LaneResult>();
  for (const lane of lanes) {
    log(`\n──────── ${lane.label} ────────\n`);
    const result = await exec(lane);
    results.set(lane.key, result);

    const required = result.failed.filter((name) => !(name in ACCEPTED_FAILURES));
    if (required.length > 0) {
      // HALTED, NOT SKIPPED. A later lane cannot hide this, and running twelve
      // more minutes of Postgres to learn something already known wastes the
      // time this command exists to save.
      log(`\nHALTED after ${lane.label}: ${required.length} required suite(s) failed — ${required.join(", ")}`);
      return { results, halted: lane };
    }
  }
  return { results, halted: null };
}

/**
 * KNOWN LIMITATION: a lane is silent until it finishes.
 *
 * execFile buffers, so the own-database lane prints nothing for about twelve
 * minutes and then all at once. The FINAL tally is what this command exists
 * to give and that is unaffected, but twelve minutes of silence reads like a
 * hang the first time somebody sees it.
 *
 * Streaming instead of buffering is a small change and it is NOT made here,
 * because it changes how output is captured and the parser reads that output
 * — and this file was verified by a full twenty-seven minute run. Changing
 * the capture mechanism without repeating that run would be trading a proven
 * result for a nicer one. Recorded as the next thing to do rather than
 * slipped in unverified.
 */
function spawnLane(lane: Lane): Promise<LaneResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(
      `npx tsx scripts/${lane.runner}`,
      { env: { ...process.env }, maxBuffer: 40 * 1024 * 1024, shell: true, timeout: 45 * 60 * 1000 },
      (_error, stdout, stderr) => {
        const output = `${stdout}${stderr}`;
        process.stdout.write(output);
        // NOT trimmed — see suiteNameFrom. The indentation is the only thing
        // separating a runner's own verdict from a suite's inner assertions.
        const lines = output.split("\n").map((l) => l.replace(/\r$/, ""));
        const reported: string[] = [];
        const failed: string[] = [];
        for (const line of lines) {
          const name = suiteNameFrom(line);
          if (!name) continue;
          reported.push(name);
          if (line.startsWith("FAIL")) failed.push(name);
        }
        const tally = output.match(lane.tally);
        resolve({
          // The lane's EXIT CODE is deliberately not consulted: two of the four
          // exit 0 with failures by design. What it reported is the truth.
          ok: failed.length === 0,
          reported,
          failed,
          passed: tally ? Number(tally[1]) : 0,
          total: tally ? Number(tally[2]) : 0,
          seconds: Math.round((Date.now() - started) / 1000),
        });
      }
    );
  });
}

async function main(): Promise<void> {
  const suites = allSuites();

  const inventory = {
    discovered: suites.length,
    browser: suites.filter((f) => httpLane(f) === "browser").length,
    http: suites.filter((f) => httpLane(f) !== null && httpLane(f) !== "browser").length,
    db: suites.filter((f) => httpLane(f) === null && needsDatabase(f)).length,
    code: suites.filter(isCodeOnly).length,
    live: suites.filter(isCodeOnlyWithLiveModel).length,
    own: suites.filter(ownDatabaseLane).length,
    excluded: Object.keys(PERMANENTLY_EXCLUDED).length,
    unclaimed: unclaimedSuites(),
  };
  const assigned =
    inventory.browser + inventory.http + inventory.db + inventory.code +
    inventory.live + inventory.own + inventory.excluded;

  console.log("Suite inventory, from scripts/lib/suiteLanes.ts:\n");
  console.log(`  discovered            ${inventory.discovered}`);
  console.log(`  assigned to a lane    ${assigned}`);
  console.log(`  unclaimed             ${inventory.unclaimed.length}`);

  // ============ THE INVARIANT, BEFORE ANYTHING RUNS ================
  //
  // Not a pinned count. Asserting "284" would be a hand-maintained number that
  // goes wrong the day somebody legitimately adds a suite — the exact drift
  // the lane functions exist to avoid. What must hold is that the lanes
  // PARTITION the directory: everything discovered is assigned exactly once,
  // and nothing is left over. The counts are printed so a suite quietly
  // disappearing is visible too.
  if (inventory.unclaimed.length > 0 || assigned !== inventory.discovered) {
    console.error(
      `\nREFUSING TO RUN. The lanes do not partition scripts/.\n` +
        `  discovered ${inventory.discovered}, assigned ${assigned}, unclaimed ${inventory.unclaimed.length}\n` +
        (inventory.unclaimed.length > 0 ? `  unclaimed: ${inventory.unclaimed.join(", ")}\n` : "") +
        `\nA suite no lane claims is a suite nothing runs, and a total that does not add up means\n` +
        `this command cannot honestly say what it covered. Fix scripts/lib/suiteLanes.ts first.`
    );
    process.exit(1);
  }

  const willExecute = inventory.http + inventory.db + inventory.code + inventory.own;
  const heldBack = inventory.browser + inventory.live + inventory.excluded;
  console.log(`  will execute          ${willExecute}`);
  console.log(`  held back            ${heldBack}  (${inventory.browser} browser, ${inventory.live} live-model, ${inventory.excluded} permanently excluded)`);

  const startedAt = Date.now();
  const { results, halted } = await runLanesInOrder(LANES, spawnLane);

  // ======================= the one tally ============================
  console.log("\n════════════════════ FULL REGRESSION ════════════════════\n");

  let executed = 0;
  let passed = 0;
  const allFailed: string[] = [];
  const seen = new Map<string, string>();
  const doubleCounted: string[] = [];

  for (const lane of LANES) {
    const r = results.get(lane.key);
    if (!r) {
      console.log(`  ${lane.label.padEnd(44)} NOT RUN`);
      continue;
    }
    executed += r.reported.length;
    passed += r.passed;
    allFailed.push(...r.failed);
    for (const name of r.reported) {
      const already = seen.get(name);
      if (already && already !== lane.key) doubleCounted.push(`${name} (${already} and ${lane.key})`);
      seen.set(name, lane.key);
    }
    console.log(
      `  ${lane.label.padEnd(44)} ${String(r.passed).padStart(3)}/${String(r.total).padEnd(3)}  ${r.seconds}s`
    );
  }

  const accepted = allFailed.filter((n) => n in ACCEPTED_FAILURES);
  const required = allFailed.filter((n) => !(n in ACCEPTED_FAILURES));
  // A suppression that is no longer needed must not sit there quietly.
  const staleAcceptances = halted
    ? []
    : Object.keys(ACCEPTED_FAILURES).filter((n) => seen.has(n) && !allFailed.includes(n));

  console.log("");
  console.log(`  discovered              ${inventory.discovered}`);
  console.log(`  executed                ${executed}`);
  console.log(`  passed                  ${passed}`);
  console.log(`  failed (required)       ${required.length}`);
  console.log(`  failed (accepted)       ${accepted.length}`);
  console.log(`  intentionally excluded  ${heldBack}  (${inventory.browser} browser via --browser, ${inventory.live} live-model via --with-live, ${inventory.excluded} permanently excluded)`);
  console.log(`  unclaimed               ${inventory.unclaimed.length}`);

  if (accepted.length > 0) {
    console.log("\n  Accepted failures — each one a decision, not a defect:");
    for (const name of accepted) console.log(`    ${name}: ${ACCEPTED_FAILURES[name]}`);
  }
  if (staleAcceptances.length > 0) {
    console.log("\n  STALE ACCEPTANCES — these pass now and should leave ACCEPTED_FAILURES:");
    for (const name of staleAcceptances) console.log(`    ${name}`);
  }
  if (required.length > 0) {
    console.log("\n  REQUIRED FAILURES:");
    for (const name of required) console.log(`    ${name}`);
  }
  if (doubleCounted.length > 0) {
    console.log("\n  COUNTED TWICE — a suite reported by two lanes:");
    for (const d of doubleCounted) console.log(`    ${d}`);
  }

  // ============ EXECUTED MUST ACCOUNT FOR EVERY SUITE ==============
  //
  // The arithmetic is the check: what ran, plus what was deliberately held
  // back, has to be everything discovered. A suite silently skipped by a
  // runner shows up here as a shortfall rather than as a smaller, quieter
  // green number.
  const accountedFor = executed + heldBack;
  const unaccounted = halted ? 0 : inventory.discovered - accountedFor;
  if (!halted && unaccounted !== 0) {
    console.log(`\n  UNACCOUNTED: ${unaccounted} suite(s). executed ${executed} + held back ${heldBack} != discovered ${inventory.discovered}`);
  }

  const minutes = Math.round((Date.now() - startedAt) / 60000);
  const green = required.length === 0 && doubleCounted.length === 0 && unaccounted === 0 && !halted;
  console.log(`\n  ${green ? "PASS" : "FAIL"} — full regression in ${minutes}m\n`);
  process.exit(green ? 0 : 1);
}

// Only when run directly. Imported by verify-run-all-suites.ts for the
// sequencing tests, which must not start twenty-five minutes of suites.
if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
