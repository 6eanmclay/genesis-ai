import { execFile } from "child_process";
import { readdirSync } from "fs";
import { isCodeOnly, isCodeOnlyWithLiveModel, SCRIPTS_DIR } from "./lib/suiteLanes";

// THE THIRD LANE: suites that need nothing at all.
//
//   npx tsx scripts/run-code-suites.ts              # all of them
//   npx tsx scripts/run-code-suites.ts field-labels # one, output streamed
//
// ============ WHY THIS EXISTS (gap 23) ==============================
//
// BACKEND_FOUNDATION_GAPS.md item 23 says sixty-one suites bring their own
// Postgres and therefore belong to no runner, and that the right fix is a
// third runner rather than widening the HTTP lane — which was tried, took
// eleven minutes, broke a passing suite, and was reverted.
//
// Asking the lane functions for every verify-* file found the recorded 61 and
// something the gap did not record: ANOTHER 106 SUITES NEED NO INFRASTRUCTURE
// AT ALL and were equally unrun. Pure functions, source assertions, vocabulary
// checks. They cost milliseconds and nothing had run them.
//
// This is that half — the cheap half, taken first because it needs no
// arrangements and closes the larger number. The real-Postgres half stays
// recorded in gap 23.
//
// ============ WHAT THIS CHANGES ABOUT WHAT WE CLAIM =================
//
// "Full regression" has meant "the two lanes that have runners" — 117 suites
// of 284. That was not a lie anybody told on purpose; it is what happens when
// a lane has no runner and nothing says so out loud. This lane is what makes
// the sentence true.
//
// ============ DELIBERATELY NOT PARALLEL =============================
//
// Same shape as run-db-suites.ts, one after another. These are fast enough
// that concurrency would buy little, and a suite that fails only when run
// beside another is a finding worth having rather than a flake to engineer
// around — which is exactly what the database lane's own ordering filter
// exists to reproduce.

async function runSuite(
  file: string,
  streamOutput: boolean
): Promise<{ file: string; ok: boolean; tail: string; ms: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    // Through the shell, for the same reason run-db-suites.ts does it: tsx is
    // not a local dependency and runs from the npx cache, so there is no
    // stable path to hand to execFile.
    execFile(
      `npx tsx scripts/${file}`,
      {
        // NO DATABASE_URL, deliberately. A suite in this lane must not need
        // one, and handing it the harness url would let a suite that quietly
        // reaches for Prisma pass here and hide from the lane that would
        // actually exercise it.
        env: { ...process.env },
        maxBuffer: 20 * 1024 * 1024,
        shell: true,
      },
      (error, stdout, stderr) => {
        const output = `${stdout}${stderr}`.trimEnd();
        const lines = output
          .split("\n")
          .filter((line) => !/^\s+at |node_modules|^\s*$/.test(line));
        if (streamOutput) console.log(output);
        resolve({
          file,
          ok: !error,
          tail: lines.slice(-6).map((line) => line.trim()).join(" | ").slice(0, 300),
          ms: Date.now() - started,
        });
      }
    );
  });
}

async function main() {
  // --with-live runs the seven suites that construct a real model client too.
  // Held back by default because they fail on the ACCOUNT rather than on the
  // code, and a lane whose red is usually somebody else s billing is a lane
  // people stop reading.
  const withLive = process.argv.includes("--with-live");
  const only = process.argv.filter((a) => !a.startsWith("--"))[2] ?? null;

  const suites = readdirSync(SCRIPTS_DIR)
    .filter((f) => f.startsWith("verify-") && f.endsWith(".ts"))
    .filter((f) => isCodeOnly(f) || (withLive && isCodeOnlyWithLiveModel(f)))
    // The same comma-separated filter the database lane takes, and for the
    // same reason: a suite that fails only after another one cannot be
    // reproduced by a filter that names a single suite.
    .filter((f) => (only ? only.split(",").some((o) => f.includes(o.trim())) : true))
    .sort();

  if (only && suites.length === 0) {
    console.error(`No code-only suite matches "${only}".`);
    process.exit(1);
  }

  console.log(`Running ${suites.length} code-only suites. No database, no server.\n`);

  const results: { file: string; ok: boolean; tail: string; ms: number }[] = [];
  for (const file of suites) {
    const result = await runSuite(file, suites.length === 1);
    results.push(result);
    console.log(
      `${result.ok ? "PASS" : "FAIL"}  ${file.replace(/^verify-|\.ts$/g, "")}` +
        (result.ms > 5000 ? `  (${Math.round(result.ms / 1000)}s)` : "")
    );
    if (!result.ok) console.log(`        ${result.tail}`);
  }

  const passed = results.filter((r) => r.ok).length;
  const seconds = Math.round(results.reduce((sum, r) => sum + r.ms, 0) / 1000);
  console.log(`\n${passed}/${results.length} code-only suites pass. (${seconds}s)`);

  // EXITS NON-ZERO ON A FAILURE, unlike the database lane.
  //
  // That lane reports rather than fails because a suite needing
  // production-shaped data is a limitation of the harness, not a defect in the
  // code under test. Nothing in this lane has that excuse: it needs no
  // infrastructure, so a failure here is about the code.
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
