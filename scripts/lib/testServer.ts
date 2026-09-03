import { spawn, type ChildProcess } from "child_process";
import { startRealPostgres, type RealPostgres } from "./realPostgres";
import { TEST_DATABASE_ENV } from "./requireTestDatabase";
import { reserveFreePort } from "./freePort";

// A real Next server, on a real port, against the test database (2026-08-20).
//
// WHY THIS EXISTS. The merchant webhook's order-creation branch ends in Next's
// `after()`, which throws outside a request scope — so calling the exported POST
// directly can never reach it. That left the single most important path on the
// money route (the one that actually writes the Order) exercised only at the
// database-constraint level.
//
// The alternatives were both wrong. Stubbing `after()` would test a route that
// does not exist in production. Reaching into Next's internal
// work-async-storage would couple the tests to private API that changes between
// minor versions. So this runs the actual server and speaks HTTP to it: real
// runtime, real routing, real request scope, real `after()`.
//
// ============================ THE SAFETY PROBLEM ============================
//
// `next dev` loads .env files. This repo's .env carries a real DATABASE_URL.
// If the child ignored the injected one, the suite would write orders into a
// live merchant's database — the exact thing scripts/lib/requireTestDatabase.ts
// exists to prevent, arriving through a back door that guard cannot see, because
// the guard runs in the TEST process and the writes happen in the SERVER
// process.
//
// So the server is proven to be on the test database before a single webhook is
// sent — see assertServerUsesTestDatabase below.
//
// ========================= HOW TO RUN THIS =================================
//
// PostgreSQL refuses to start under an administrator account on Windows, and
// that refusal is correct — Postgres protecting itself from being run with
// privileges it should never have. The fix belongs in the environment, not the
// application, so scripts/run-unelevated.ps1 drops privileges with
// `runas /trustlevel:0x20000` (same user, administrators group disabled) and
// captures the output and exit code, which runas otherwise detaches:
//
//   powershell -File scripts/run-unelevated.ps1 //     -Command "npx tsx scripts/verify-order-webhook-live.ts" //     -OutFile out.txt
//
// From an already-unelevated shell, just run the suite directly.

export interface TestServer {
  baseUrl: string;
  db: RealPostgres;
  close(): Promise<void>;
}

/**
 * Wait for OUR server, and notice when it dies.
 *
 * ============ WHY THE CHILD IS WATCHED (gap 26) ====================
 *
 * The old wait polled a port for up to three minutes and called anything that
 * answered "ready". That is two separate ways to be wrong.
 *
 * If `next dev` dies - and it does: an explicit `--port` means Next does NOT
 * move to a free one, it logs "Failed to start server" and exits 1 - then
 * nothing ever answers and the suite spent the full 180s timeout before saying
 * so. That is the 191s failure in gap 26's record.
 *
 * And if something ELSE holds the port, that something answers, and the suite
 * proceeds to test a server it did not start, with a database it does not
 * know. Adopting a stranger is worse than timing out.
 *
 * So the exit is raced against the poll. Whichever happens first is the truth.
 */
export async function waitForOwnServer(
  child: ChildProcess,
  baseUrl: string,
  port: number,
  timeoutMs: number,
  serverOutput: () => string,
): Promise<void> {
  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  child.once("exit", (code, signal) => {
    exited = { code, signal };
  });

  const deadline = Date.now() + timeoutMs;
  let lastError = "never responded";
  let announced = false;
  while (Date.now() < deadline) {
    // child.exitCode covers the case where it died before the listener above
    // was attached - a race that would otherwise fall through to the poll.
    const gone = exited ?? (child.exitCode !== null || child.signalCode !== null
      ? { code: child.exitCode, signal: child.signalCode }
      : null);
    if (gone) {
      const { code, signal } = gone as { code: number | null; signal: NodeJS.Signals | null };
      throw new Error(
        [
          `The dev server exited before it was ready (code ${code ?? "null"}, signal ${signal ?? "none"}).`,
          "",
          "It was never running, so nothing here was tested. A port already in use is the",
          "usual cause: `next dev` with an explicit --port does not move to a free one.",
          "",
          serverOutput().slice(-1500),
        ].join("\n"),
      );
    }

    // ============ OUR SERVER, NOT WHOEVER ANSWERS =====================
    //
    // Polling the port alone is not evidence. A stranger already listening
    // there answers on the first attempt - before our own child has even tried
    // to bind - so the poll succeeds, the suite is handed a server it did not
    // start, and the exit it would have failed on arrives seconds too late to
    // be noticed. That is not hypothetical: it is what the first version of
    // this function did, and verify-http-lane-integrity caught it.
    //
    // Next prints its bound address once it has the port. Waiting for OUR port
    // in OUR child's own output is what makes the readiness ours.
    if (!announced) {
      // Next prints "- Local: http://127.0.0.1:PORT" only once it HAS the port.
      // Matching a bare ":port" anywhere was not enough - the EADDRINUSE error
      // names the port too, so a failure announced itself as a success.
      announced = new RegExp(`Local:\\s+https?://[^\\s]*:${port}\\b`).test(serverOutput());
      if (!announced) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
    }

    try {
      const response = await fetch(baseUrl, { method: "GET" });
      if (response.status > 0) return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    announced
      ? `Test server did not become ready within ${timeoutMs}ms (${lastError})`
      : `The dev server never reported binding port ${port} within ${timeoutMs}ms. It did not start.\n\n${serverOutput().slice(-1500)}`,
  );
}
/**
 * The expected route must actually be served.
 *
 * ============ WHY THIS IS SEPARATE FROM THE CANARY =================
 *
 * These are two different facts and they were being read off one measurement.
 * /api/cron/status answers 401 when it is reached without credentials and NEVER
 * 404, so the two outcomes mean entirely different things:
 *
 *   404 - the route is not being served. Infrastructure. Nothing was tested.
 *   401 - the route is there, and only now can the canary say anything about
 *         WHICH DATABASE is behind it.
 *
 * Reading a 404 as "DATABASE_URL was overridden" printed a confident, wrong
 * diagnosis - it sent an investigation after a database problem that did not
 * exist. Both still refuse; neither can pass. They just no longer lie about
 * which one happened.
 *
 * The retries are for on-demand compilation, and are bounded and few: `next
 * dev` compiles a route on first request, so the first attempt can legitimately
 * arrive before it exists. A route that is still absent after this is absent.
 */
export async function assertServerServesRoute(baseUrl: string, path: string): Promise<void> {
  let status: number | string = "no answer";
  for (let attempt = 0; attempt < 10; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1000));
    const response = await fetch(`${baseUrl}${path}`).catch(() => null);
    if (!response) continue;
    status = response.status;
    if (response.status !== 404) return;
  }
  throw new Error(
    [
      `REFUSING TO RUN: the server is not serving ${path}.`,
      `It answered ${status}. That route answers 401 without credentials and never 404,`,
      "so a 404 means it is not being served at all and nothing beyond this point was tested.",
      "",
      "This is an infrastructure failure, NOT a wrong database.",
    ].join("\n"),
  );
}

/** The cron secret this harness uses. Only ever valid for the test server. */
const HARNESS_CRON_SECRET = "harness-cron-secret-not-a-real-one";

/**
 * Refuse to continue unless the SERVER is talking to the test database.
 *
 * The canary is a StoreIntegration row nothing else has, read back through
 * /api/cron/status — a minimal, read-only, DB-backed API route.
 *
 * Deliberately NOT a storefront page: a page renders a great deal and can fail
 * for reasons entirely unrelated to which database it is on, so a 500 there
 * proves nothing either way. This endpoint does one query and returns JSON, so
 * seeing the canary in it is positive proof rather than absence of an error.
 */
export async function assertServerUsesTestDatabase(baseUrl: string, db: RealPostgres, slug: string): Promise<void> {
  const user = await db.prisma.user.create({ data: { email: `${slug}@example.test` } });
  const store = await db.prisma.store.create({
    data: {
      userId: user.id,
      name: "Harness Canary",
      slug,
      tagline: "Proves the server is on the test database",
      description: "If you can read this in production, stop.",
    },
  });
  await db.prisma.storeIntegration.create({
    data: { storeId: store.id, provider: "STRIPE", status: "CONNECTED", externalAccountId: slug },
  });

  // ============ ONE REQUEST, BECAUSE THE ROUTE IS ALREADY PROVEN ====
  //
  // This used to retry ten times, and the comment explaining why said the route
  // might not be compiled yet - which was true, and was the wrong place to
  // solve it. assertServerServesRoute now establishes that the route is served
  // BEFORE this runs, so the only question left here is which database is
  // behind it, and that cannot change between attempts: the canary row was
  // written before the request was made.
  //
  // So one request. A retry loop over a question whose answer never changes is
  // just somewhere for a real mismatch to hide, ten seconds at a time.
  const response = await fetch(`${baseUrl}/api/cron/status`, {
    headers: { authorization: `Bearer ${HARNESS_CRON_SECRET}` },
  }).catch(() => null);
  const body = (response ? await response.json().catch(() => ({})) : {}) as {
    integrations?: { storeId: string }[];
  };
  const sawCanary = !!response?.ok && (body.integrations ?? []).some((i) => i.storeId === store.id);

  if (!sawCanary) {
    throw new Error(
      [
        "REFUSING TO RUN: the test server is not using the test database.",
        `A canary integration was created in the harness and /api/cron/status answered ${response?.status ?? "nothing"} without it.`,
        "",
        "The route IS being served - that was checked first - so this is not a missing",
        "route or a server still starting. The server is answering from a DIFFERENT",
        "database than the one this harness created.",
        "",
        "That usually means DATABASE_URL was overridden, almost certainly by a .env file,",
        "and posting webhooks at this server could write orders into a real merchant's database.",
      ].join("\n")
    );
  }
}

/**
 * Env vars a lane runner sets so child suites SHARE one server.
 *
 * ============ WHY SHARING MATTERS (2026-08-30) ====================
 *
 * `next dev` takes the better part of a minute to become ready, and fifteen
 * suites already start their own. Run one after another that is a quarter of an
 * hour of startup before a single assertion — which is how a lane stops being
 * run.
 *
 * A runner starts one server, sets these, and every suite it spawns reuses it.
 * A suite run on its own sees no variables and starts its own exactly as
 * before, so nothing that exists today changes.
 */
export const SHARED_SERVER_URL = "GENESIS_HARNESS_BASE_URL";
export const SHARED_SERVER_DB = "GENESIS_HARNESS_DATABASE_URL";

export async function startTestServer(options: { timeoutMs?: number } = {}): Promise<TestServer> {
  // ============ REUSE, WHEN A RUNNER PROVIDED ONE ================
  //
  // The safety guard is NOT skipped: the shared server was proven to be on the
  // test database when the runner started it, and this connects to that same
  // database by the url the runner passed. A suite can no more reach production
  // this way than it could on its own.
  const sharedUrl = process.env[SHARED_SERVER_URL];
  const sharedDb = process.env[SHARED_SERVER_DB];
  if (sharedUrl && sharedDb) {
    const { connectRealPostgres } = await import("./realPostgres");
    const db = await connectRealPostgres(sharedDb);
    return {
      baseUrl: sharedUrl,
      db,
      // Closing a SHARED server is the runner's job. A suite that killed it
      // would take the rest of the lane down with it.
      close: async () => { await db.close(); },
    };
  }

  return startOwnServer(options);
}

async function startOwnServer(options: { timeoutMs?: number } = {}): Promise<TestServer> {
  // A REAL Postgres, not PGlite: a Next server opens a connection pool, and
  // PGlite drops the connection the moment a second one appears.
  const db = await startRealPostgres();
  const port = await reserveFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const canarySlug = `harness-canary-${port}`;

  const child: ChildProcess = spawn(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["next", "dev", "--port", String(port), "--hostname", "127.0.0.1"],
    {
      env: {
        ...process.env,
        DATABASE_URL: db.url,
        [TEST_DATABASE_ENV]: "1",
        // Deterministic secrets the suites sign with. Set here so the server
        // and the test agree without either reading a real one.
        STRIPE_SECRET_KEY: "sk_test_harness",
        STRIPE_WEBHOOK_SECRET: "whsec_harness_merchant",
        STRIPE_PLATFORM_WEBHOOK_SECRET: "whsec_harness_platform",
        // Keep the dev server quiet and non-interactive.
        CRON_SECRET: HARNESS_CRON_SECRET,
        NEXT_TELEMETRY_DISABLED: "1",
        CI: "1",
      },
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  // Kept so a server that never starts reports WHY, instead of timing out with
  // "fetch failed" and no clue.
  const output: string[] = [];
  child.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString()));

  const close = async () => {
    // Windows needs the whole TREE killed, and it needs to be AWAITED.
    //
    // Both matter, and both cost a run to learn. `next dev` under a shell is a
    // grandchild, so child.kill() reaps the shell and leaves the server holding
    // the port. And firing taskkill without waiting lets this process exit
    // first, which orphans it — after which Next 16 refuses to start another
    // dev server in the same directory ("Another next dev server is already
    // running"), so the NEXT run fails for a reason that has nothing to do with
    // what it was testing.
    if (process.platform === "win32" && child.pid) {
      await new Promise<void>((resolve) => {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        killer.on("exit", () => resolve());
        killer.on("error", () => resolve());
      });
    } else {
      child.kill("SIGTERM");
    }
    await db.close();
  };

  try {
    await waitForOwnServer(child, baseUrl, port, options.timeoutMs ?? 180_000, () => output.join(""));
    // Infrastructure first, then which database. Two facts, two messages.
    await assertServerServesRoute(baseUrl, "/api/cron/status");
    await assertServerUsesTestDatabase(baseUrl, db, canarySlug);
  } catch (error) {
    const log = output.join("").trim();
    await close();
    throw new Error(
      [
        error instanceof Error ? error.message : String(error),
        "",
        log ? "--- next dev output (tail) ---" : "(next dev produced no output)",
        log ? log.slice(-2000) : "",
      ].join("\n")
    );
  }

  return { baseUrl, db, close };
}
