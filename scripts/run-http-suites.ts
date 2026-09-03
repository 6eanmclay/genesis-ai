import { execFile } from "child_process";
import { readdirSync } from "fs";
import { startTestServer, SHARED_SERVER_URL, SHARED_SERVER_DB, SERVER_LOG_PATH } from "./lib/testServer";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { TEST_DATABASE_ENV } from "./lib/requireTestDatabase";
import { httpLane, type HttpLane } from "./lib/suiteLanes";

// RUN EVERYTHING THAT NEEDS A RUNNING SERVER:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/run-http-suites.ts" -OutFile out.txt
//
//   ...and one suite by name:
//     -Command "npx tsx scripts/run-http-suites.ts http-boundaries"
//
// ============ WHY THIS EXISTS (2026-08-30) =============================
//
// Sixteen suites already drove a real Next server and nothing ran them
// together. Each was a separate command somebody had to remember, so in
// practice they were run when somebody suspected the thing they covered — which
// is the opposite of what a regression suite is for.
//
// The obstacle was cost, not intent: `next dev` takes most of a minute to
// become ready, and a runner that started one per suite would spend a quarter
// of an hour compiling before its first assertion. So this starts ONE server
// and hands it to every suite that can share it.
//
// ============ AND WHY SOME SUITES STILL GET THEIR OWN =================
//
// A suite that resets the database cannot share one: wiping it mid-lane would
// fail every other suite in ways that look like real defects and take an
// afternoon to trace. Those get a server to themselves, which they do simply by
// not being handed the shared one — lib/testServer falls back to starting its
// own when the environment says nothing.
//
// The browser suites are excluded by default. They need a Playwright binary
// that may not be installed, and they are slow enough to want running
// deliberately. `--browser` includes them.
//
// ============ POSTGRES REFUSES TO RUN AS ADMINISTRATOR ================
//
// Correctly — it is protecting itself from privileges it should never have. So
// this must be run through scripts/run-unelevated.ps1, exactly like every other
// suite in this lane. Running it elevated fails at the database, not here.

const ARGS = process.argv.slice(2);
const INCLUDE_BROWSER = ARGS.includes("--browser");

// ============ ISOLATION BY DEFAULT (2026-08-30) =======================
//
// Sharing one server was the original point of this runner, and measuring it
// changed my mind. It saves about twenty seconds across five suites, and it
// cost two false failures to find out why: verify-carriage-webhook-live
// configures the server through its own environment, and verify-checkout-e2e
// reported "36 passed, 0 failed" and then crashed on exit with a libuv
// double-close, because a shared process ends up with two Prisma clients
// against one database.
//
// A lane that reports a passing suite as failed is worse than a slow one — it
// is the exact false-failure-against-good-code problem this repository has been
// bitten by before. So every suite gets its own server unless somebody asks,
// and the sharing machinery stays for when there are fifty suites and the
// saving is minutes rather than seconds.
const SHARE_SERVER = ARGS.includes("--share");
const FILTERS = ARGS.filter((a) => !a.startsWith("--"));

interface Suite {
  file: string;
  lane: HttpLane;
}

function discover(): Suite[] {
  return readdirSync("scripts")
    .filter((f) => f.startsWith("verify-") && f.endsWith(".ts"))
    .map((file) => ({ file, lane: httpLane(file) }))
    .filter((s): s is Suite => s.lane !== null)
    .filter((s) => (s.lane === "browser" ? INCLUDE_BROWSER : true))
    .filter((s) => FILTERS.length === 0 || FILTERS.some((f) => s.file.includes(f)))
    .sort((a, b) => a.file.localeCompare(b.file));
}

interface Outcome {
  file: string;
  lane: HttpLane;
  ok: boolean;
  tail: string;
  seconds: number;
}


// ============ A FAILED SUITE MUST SAY WHAT THE SERVER DID ========
//
// Gap 27: verify-order-webhook-live failed once with a 200 and no order.
// The handler can reach that outcome two different ways - the store could
// not be resolved, or the order write failed permanently - and they are told
// apart by ONE line it logs server-side.
//
// That line existed on the failing run and was thrown away, because the
// server's output was only ever included in a STARTUP error. So the single
// artefact saying what the application actually did was discarded at exactly
// the moment it was needed, and the failure did not recur in thirteen further
// runs. Rare is survivable; undiagnosable is not.
//
// Printed ONLY on failure, and tail-limited, so a passing lane stays readable.
const SERVER_LOG_LINES = 40;

function printServerLog(logPath: string): void {
  let text = "";
  try {
    text = readFileSync(logPath, "utf8").trim();
  } catch {
    // No log is not a second failure to report.
    return;
  }
  if (!text) return;
  const lines = text.split("\n");
  const shown = Math.min(SERVER_LOG_LINES, lines.length);
  console.log(
    `        --- the server's own log (last ${shown} of ${lines.length} lines) ---`,
  );
  for (const line of lines.slice(-SERVER_LOG_LINES)) {
    console.log(`        ${line}`);
  }
}
function runSuite(suite: Suite, env: NodeJS.ProcessEnv, stream: boolean): Promise<Outcome> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    execFile(
      `npx tsx scripts/${suite.file}`,
      { env, maxBuffer: 40 * 1024 * 1024, shell: true },
      (error, stdout, stderr) => {
        const output = `${stdout}${stderr}`.trimEnd();
        if (stream) console.log(output);
        const lines = output
          .split("\n")
          .filter((line) => !/^\s+at |node_modules|^\s*$/.test(line));
        resolve({
          file: suite.file,
          lane: suite.lane,
          ok: !error,
          tail: lines.slice(-6).map((l) => l.trim()).join(" | ").slice(0, 300),
          seconds: Math.round((Date.now() - startedAt) / 1000),
        });
      },
    );
  });
}

async function main(): Promise<void> {
  const suites = discover();
  if (suites.length === 0) {
    console.log("No HTTP suites matched.");
    return;
  }

  const shared = SHARE_SERVER ? suites.filter((s) => s.lane === "shared") : [];
  const solo = suites.filter((s) => !shared.includes(s));

  console.log(
    `${suites.length} suite(s) need a server: ${shared.length} can share one, ${solo.length} need their own.\n`,
  );

  const outcomes: Outcome[] = [];

  // ---- the shared server -------------------------------------------------
  if (shared.length > 0) {
    console.log("Starting one server for the shared lane...");
    const server = await startTestServer();
    console.log(`  ready at ${server.baseUrl}\n`);
    try {
      for (const suite of shared) {
        // Sequential, deliberately. They share a database, and a suite that
        // counts rows while another is inserting them fails for a reason that
        // has nothing to do with the code — the same interference the database
        // lane already learned to avoid.
        const outcome = await runSuite(
          suite,
          {
            ...process.env,
            [SHARED_SERVER_URL]: server.baseUrl,
            [SHARED_SERVER_DB]: server.db.url,
            DATABASE_URL: server.db.url,
            [TEST_DATABASE_ENV]: "1",
          },
          suites.length === 1,
        );
        outcomes.push(outcome);
        console.log(`${outcome.ok ? "PASS" : "FAIL"}  ${outcome.file}  (${outcome.seconds}s)`);
        if (!outcome.ok) console.log(`        ${outcome.tail}`);
      }
    } finally {
      // Always, even if a suite threw. An orphaned `next dev` holds the port
      // and Next then refuses to start another in the same directory, so the
      // NEXT run fails for a reason that has nothing to do with what it tests.
      await server.close();
    }
  }

  // ---- the ones that need their own --------------------------------------
  // Each suite gets its own log file, so a failure prints the log of the
  // server THAT suite was talking to and nothing else.
  const logDir = mkdtempSync(join(tmpdir(), "genesis-server-logs-"));
  try {
    for (const suite of solo) {
      console.log(`\nRunning ${suite.file} on its own server (${suite.lane})...`);
      const logPath = join(logDir, `${suite.file}.log`);
      const outcome = await runSuite(
        suite,
        { ...process.env, [SERVER_LOG_PATH]: logPath },
        suites.length === 1,
      );
      outcomes.push(outcome);
      console.log(`${outcome.ok ? "PASS" : "FAIL"}  ${outcome.file}  (${outcome.seconds}s)`);
      if (!outcome.ok) {
        console.log(`        ${outcome.tail}`);
        printServerLog(logPath);
      }
    }
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }

  const passed = outcomes.filter((o) => o.ok).length;
  const seconds = outcomes.reduce((total, o) => total + o.seconds, 0);
  console.log(`\n${passed}/${outcomes.length} HTTP suites pass. (${seconds}s)`);
  if (!INCLUDE_BROWSER) {
    console.log("Browser suites were not run. Add --browser to include them.");
  }
  process.exitCode = passed === outcomes.length ? 0 : 1;
}

void main();
