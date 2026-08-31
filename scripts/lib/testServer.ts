import { spawn, type ChildProcess } from "child_process";
import { startRealPostgres, type RealPostgres } from "./realPostgres";
import { TEST_DATABASE_ENV } from "./requireTestDatabase";

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

/** Deterministic per-process, well clear of anything else likely to be running. */
function pickPort(): number {
  return 41000 + (process.pid % 9000);
}

async function waitForServer(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "never responded";
  while (Date.now() < deadline) {
    try {
      // Any answer at all means the server is listening; 404 is fine here.
      const response = await fetch(baseUrl, { method: "GET" });
      if (response.status > 0) return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Test server did not become ready within ${timeoutMs}ms (${lastError})`);
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
async function assertServerUsesTestDatabase(baseUrl: string, db: RealPostgres, slug: string): Promise<void> {
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

  // ============ THE ROUTE MAY NOT BE COMPILED YET (2026-08-30) ======
  //
  // waitForServer only proves the server answers SOMETHING; `next dev` compiles
  // each route on first request, and a route it has not reached yet can answer
  // 404 rather than compiling in time. That surfaced as a suite failing with
  // "GET /api/cron/status 404" — the safety guard refusing, not because the
  // database was wrong but because the route was not ready.
  //
  // Retried, never relaxed. The canary must still be SEEN; this only gives the
  // compiler time to produce the route that would show it. A server genuinely
  // on the wrong database fails every attempt and still refuses below.
  let response: Response | null = null;
  let body: { integrations?: { storeId: string }[] } = {};
  let sawCanary = false;
  for (let attempt = 0; attempt < 10 && !sawCanary; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1000));
    response = await fetch(`${baseUrl}/api/cron/status`, {
      headers: { authorization: `Bearer ${HARNESS_CRON_SECRET}` },
    }).catch(() => null);
    if (!response) continue;
    body = (await response.json().catch(() => ({}))) as { integrations?: { storeId: string }[] };
    sawCanary = response.ok && (body.integrations ?? []).some((i) => i.storeId === store.id);
  }

  if (!sawCanary) {
    throw new Error(
      [
        "REFUSING TO RUN: the test server is not using the test database.",
        `A canary integration was created in the harness and /api/cron/status answered ${response?.status ?? "nothing"} without it, after ten attempts.`,
        "",
        "That means DATABASE_URL was overridden — almost certainly by a .env file — and",
        "posting webhooks at this server could write orders into a real merchant's database.",
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
  const port = pickPort();
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
    await waitForServer(baseUrl, options.timeoutMs ?? 180_000);
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
