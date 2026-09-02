import { execFile } from "child_process";
import { readdirSync } from "fs";
import { ownDatabaseLane, unclaimedSuites, SCRIPTS_DIR } from "./lib/suiteLanes";

// THE FOURTH LANE: suites that bring their own Postgres.
//
//   npx tsx scripts/run-pg-suites.ts                 # all of them, ~15 minutes
//   npx tsx scripts/run-pg-suites.ts promotions      # one, output streamed
//   npx tsx scripts/run-pg-suites.ts a,b,c           # several, in order
//
// ============ THE OTHER HALF OF GAP 23 ==============================
//
// BACKEND_FOUNDATION_GAPS.md item 23: sixty-one suites bring their own database,
// which excludes them from the shared runner, and start no server, which
// excludes them from the HTTP lane. So nothing ran them. Widening the HTTP lane
// was tried once, took eleven minutes, broke a passing suite, and was reverted;
// the entry says the right fix is a runner of their own on its own cadence.
// This is it, and run-code-suites.ts was the cheap half.
//
// ============ SEQUENTIAL, AND NOT APOLOGISING FOR IT =================
//
// Every suite here starts a real Postgres. Running them concurrently would mean
// dozens of live database servers on one laptop, which is not a faster test run
// — it is a different test run, measuring contention. Fifteen minutes of honest
// serial execution is the actual cost of this coverage, and the point of the
// exercise is to make the regression claim true rather than short.
//
// ============ IT CANNOT SILENTLY OMIT A SUITE ========================
//
// The lane is defined as the COMPLEMENT — what no other lane claims — and this
// refuses to run at all while any verify-* file is unclaimed. Defining it as
// /startRealPostgres/ instead would have quietly dropped verify-ledger-live.ts,
// which brings its own database through a different helper. A runner that
// skips a suite and says nothing is how 167 of 284 suites went unexecuted.

async function runSuite(
  file: string,
  streamOutput: boolean
): Promise<{ file: string; ok: boolean; tail: string; ms: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(
      `npx tsx scripts/${file}`,
      {
        // NO DATABASE_URL AND NO TEST-DATABASE FLAG. Each suite arranges its
        // own, which is the whole reason it is in this lane; handing it one
        // would be handing it the shared database it was excluded from.
        env: { ...process.env },
        maxBuffer: 20 * 1024 * 1024,
        // Generous, because a suite here pays real Postgres startup before it
        // asserts anything. A suite that genuinely hangs still ends the run
        // rather than holding it forever.
        timeout: 6 * 60 * 1000,
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
          tail: lines.slice(-8).map((line) => line.trim()).join(" | ").slice(0, 400),
          ms: Date.now() - started,
        });
      }
    );
  });
}

async function main() {
  // BEFORE ANYTHING ELSE. An unclaimed suite means the four lanes no longer
  // partition the directory, and continuing would report a pass over a set
  // nobody can name.
  const unclaimed = unclaimedSuites();
  if (unclaimed.length > 0) {
    console.error(
      `${unclaimed.length} verify-* suite(s) belong to no lane and no named exclusion:\n` +
        unclaimed.map((f) => `  ${f}`).join("\n") +
        `\n\nAdd them to a lane in scripts/lib/suiteLanes.ts, or to PERMANENTLY_EXCLUDED with a reason.`
    );
    process.exit(1);
  }

  const only = process.argv.filter((a) => !a.startsWith("--"))[2] ?? null;

  const all = readdirSync(SCRIPTS_DIR)
    .filter((f) => f.startsWith("verify-") && f.endsWith(".ts"))
    .filter(ownDatabaseLane)
    .sort();

  const suites = all.filter((f) =>
    only ? only.split(",").some((o) => f.includes(o.trim())) : true
  );

  if (only && suites.length === 0) {
    console.error(`No own-database suite matches "${only}".`);
    process.exit(1);
  }

  // DISCOVERED AND EXECUTED, BOTH PRINTED. If a filter or a future exclusion
  // ever narrows this, the difference is on screen rather than implied.
  console.log(
    `${all.length} suites bring their own database. Running ${suites.length}.` +
      (suites.length === all.length ? "" : ` (${all.length - suites.length} not selected by the filter)`)
  );
  console.log("Each starts a real Postgres, so this is serial and slow by design.\n");

  const results: { file: string; ok: boolean; tail: string; ms: number }[] = [];
  for (const [i, file] of suites.entries()) {
    const result = await runSuite(file, suites.length === 1);
    results.push(result);
    console.log(
      `${result.ok ? "PASS" : "FAIL"}  [${String(i + 1).padStart(2)}/${suites.length}]  ` +
        `${file.replace(/^verify-|\.ts$/g, "")}  (${Math.round(result.ms / 1000)}s)`
    );
    if (!result.ok) console.log(`        ${result.tail}`);
  }

  const passed = results.filter((r) => r.ok).length;
  const seconds = Math.round(results.reduce((sum, r) => sum + r.ms, 0) / 1000);
  console.log(`\n${passed}/${results.length} own-database suites pass. (${Math.round(seconds / 60)}m ${seconds % 60}s)`);

  // REPORTS RATHER THAN FAILS, like the database lane and unlike the code lane.
  // A suite here can fail for a reason that is about this machine — Postgres
  // refusing to start under an administrator account is the documented one —
  // and a runner that exits non-zero on that teaches people to ignore it.
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
