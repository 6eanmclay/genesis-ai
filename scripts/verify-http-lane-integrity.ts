import { spawn } from "child_process";
import {
  startTestServer,
  waitForOwnServer,
  assertServerServesRoute,
  assertServerUsesTestDatabase,
  SERVER_LOG_PATH,
} from "@/scripts/lib/testServer";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { reserveFreePort } from "@/scripts/lib/freePort";
import { createServer } from "http";

// A GREEN HTTP SUITE MUST MEAN SOMETHING (gap 26):
//
//   npx tsx scripts/run-http-suites.ts http-lane-integrity
//
// ============ THE INVARIANT ========================================
//
// A suite may only pass if the server actually started, with the expected
// route, against the expected database, and the behaviour was verified. Every
// other outcome is a refusal. There is no fourth answer, and in particular
// there is no "probably fine".
//
// ============ WHY THIS SUITE EXISTS ================================
//
// The HTTP lane lost about one suite per full run, and the reasons were read
// wrongly twice. The first guess was a shared dev server; there is no shared
// dev server. The second was a rewritten route manifest; eight servers started
// back to back in one .next directory served the route every time.
//
// The actual cause was in the harness's own port selection - a port derived
// from the process id, never checked - and it produced two different failures:
//
//   FATAL:  could not create any TCP/IP sockets
//   LOG:  listening on IPv6 address "::1", port 51248
//   LOG:  could not bind IPv4 address "127.0.0.1": Only one usage ...
//   LOG:  database system is ready to accept connections
//   Error: P1001: Can't reach database server at `127.0.0.1:51248`
//
// The second is why "it started" is not a fact a server can be trusted to
// report about itself. It bound one address family, said it was ready, meant
// it, and was unreachable to the only client that mattered.
//
// So this suite asserts the harness's guarantees against real servers and real
// databases, rather than asserting that the harness contains certain code.

let failures = 0;
let passes = 0;
const failed: string[] = [];

function check(label: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passes++;
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    failed.push(label);
    console.log(`  FAIL  ${label}  — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/** Runs something that must refuse, and reports HOW it refused. */
async function refusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "DID NOT REFUSE";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function main(): Promise<void> {
  // Section 5 needs this set BEFORE the server is closed, because that is
  // when the log is written. Set before it is started, so ordering cannot
  // quietly make the assertion vacuous.
  const serverLog = join(mkdtempSync(join(tmpdir(), "genesis-lane-integrity-")), "server.log");
  process.env[SERVER_LOG_PATH] = serverLog;

  const server = await startTestServer();
  let closed = false;
  try {
    console.log("=== 1. a healthy server, serving the expected route, is accepted ===");
    //
    // The control for everything below. If this ever fails, the refusals that
    // follow prove nothing: anything can refuse.
    const root = await fetch(server.baseUrl);
    check("the server answers", root.status, 200);

    // The behavioural assertion. 401 is the route REACHED and declining; the
    // sabotage that breaks the authorization check turns this red.
    const unauthenticated = await fetch(`${server.baseUrl}/api/cron/status`);
    check("the expected route is served, and refuses an unauthenticated caller", unauthenticated.status, 401);

    const authenticated = await fetch(`${server.baseUrl}/api/cron/status`, {
      headers: { authorization: "Bearer harness-cron-secret-not-a-real-one" },
    });
    check("and answers a credentialed one", authenticated.status, 200);
    const body = (await authenticated.json()) as { integrations?: unknown[] };
    check("with the shape the harness reads its canary out of", Array.isArray(body.integrations), true);

    console.log("=== 2. a route that is not served is refused, not tolerated ===");
    //
    // Against the SAME healthy server, so the only thing that changed is
    // whether the route exists. A guard that passed here would pass anything.
    const missing = await refusal(() =>
      assertServerServesRoute(server.baseUrl, "/api/definitely-not-a-route-9c1f"),
    );
    check("a missing route refuses", missing.startsWith("REFUSING TO RUN"), true);
    check("and says it is infrastructure, not a database", missing.includes("NOT a wrong database"), true);
    check("a served route does not refuse", await refusal(() => assertServerServesRoute(server.baseUrl, "/api/cron/status")), "DID NOT REFUSE");

    console.log("=== 3. a server that never started is never adopted ===");
    //
    // The failure this replaces: `next dev` with an explicit --port does not
    // move to a free one, it exits 1. The old wait polled the port regardless,
    // so a STRANGER already listening there answered, was called ready, and the
    // suite tested a server it had not started. Here a stranger is put on the
    // port deliberately.
    const port = await reserveFreePort();
    const stranger = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("I am not your server");
    });
    await new Promise<void>((resolve) => stranger.listen(port, "127.0.0.1", resolve));
    try {
      const answered = await fetch(`http://127.0.0.1:${port}`);
      check("the stranger really is answering on that port", answered.status, 200);

      const child = spawn(
        process.platform === "win32" ? "npx.cmd" : "npx",
        ["next", "dev", "--port", String(port), "--hostname", "127.0.0.1"],
        { env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", CI: "1" }, shell: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      const output: string[] = [];
      child.stdout?.on("data", (c: Buffer) => output.push(c.toString()));
      child.stderr?.on("data", (c: Buffer) => output.push(c.toString()));

      const startedAt = Date.now();
      const adopted = await refusal(() =>
        waitForOwnServer(child, `http://127.0.0.1:${port}`, port, 180_000, () => output.join("")),
      );
      const seconds = Math.round((Date.now() - startedAt) / 1000);

      check("a server that could not take the port refuses", adopted.includes("exited before it was ready"), true);
      check("rather than adopting whatever else answers there", adopted === "DID NOT REFUSE", false);
      // The old code waited the full 180s timeout before saying anything.
      check("and says so promptly, not after the full timeout", seconds < 120, true);
      await new Promise<void>((resolve) => {
        const k = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        k.on("exit", () => resolve());
        k.on("error", () => resolve());
      });
    } finally {
      await new Promise<void>((resolve) => stranger.close(() => resolve()));
    }

    console.log("=== 4. a server on the wrong database still refuses ===");
    //
    // The most important refusal in the harness, and the one that must survive
    // every change above: these suites POST webhooks. A canary written into a
    // database the server is not using must never look like a pass.
    const otherDb = await startRealPostgres();
    try {
      const wrongDatabase = await refusal(() =>
        assertServerUsesTestDatabase(server.baseUrl, otherDb, `harness-canary-elsewhere-${Date.now()}`),
      );
      check("a canary the server cannot see refuses", wrongDatabase.startsWith("REFUSING TO RUN"), true);
      check("and names the database, not the route", wrongDatabase.includes("DIFFERENT"), true);
      check("and says the route was fine", wrongDatabase.includes("route IS being served"), true);
    } finally {
      await otherDb.close();
    }
    console.log("=== 5. a failing suite can say what the server did ===");
    //
    // Gap 27 was not unresolvable because it was rare. It was unresolvable
    // because the server's output was only ever attached to a STARTUP error,
    // so a suite that failed an ASSERTION discarded the one artefact that
    // says which branch the handler took. Closing here rather than in the
    // finally is what makes the written log observable.
    await server.close();
    closed = true;

    let log = "";
    try {
      log = readFileSync(serverLog, "utf8");
    } catch {
      log = "";
    }
    check("the server's own log was captured", log.length > 0, true);
    // Its real content, not merely a file: the bound-address banner is
    // something only the server itself prints.
    check("and it holds what the server printed", /Local:|Next\.js/.test(log), true);
    check(
      "and it is labelled with the port it came from",
      new RegExp(`===== server on port \\d+ =====`).test(log),
      true,
    );
  } finally {
    if (!closed) await server.close();
  }

  console.log("");
  console.log(`${failures} failed, ${passes} passed`);
  for (const label of failed) console.log(`  - ${label}`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
