import { spawn, type ChildProcess } from "child_process";
import { startTestDatabase, type TestDatabase } from "./testDatabase";
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
// ===================== NOT YET RUN ON THIS MACHINE ==========================
//
// This harness is complete and its safety check is exercised, but the full
// path has NOT been executed here, and nothing should claim otherwise. Two
// environment constraints, both real and neither worth distorting production to
// dodge:
//
//   1. PGlite cannot serve a real Next server. Its wire server drops the
//      connection the moment a client opens a second one, and a server makes
//      concurrent queries as a matter of course.
//   2. scripts/lib/realPostgres.ts exists for exactly that reason and starts a
//      genuine Postgres — but PostgreSQL refuses to run under an ADMINISTRATOR
//      account on Windows, and this shell is elevated.
//
// Run from a non-elevated shell (or CI) and this works. Until someone has done
// that, the merchant webhook's order-creation branch is verified at the handler
// and constraint level only, which COMPLIANCE.md says in those words.

export interface TestServer {
  baseUrl: string;
  db: TestDatabase;
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
async function assertServerUsesTestDatabase(baseUrl: string, db: TestDatabase, slug: string): Promise<void> {
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

  const response = await fetch(`${baseUrl}/api/cron/status`, {
    headers: { authorization: `Bearer ${HARNESS_CRON_SECRET}` },
  });
  const body = (await response.json().catch(() => ({}))) as { integrations?: { storeId: string }[] };
  const sawCanary = response.ok && (body.integrations ?? []).some((i) => i.storeId === store.id);

  if (!sawCanary) {
    throw new Error(
      [
        "REFUSING TO RUN: the test server is not using the test database.",
        `A canary integration was created in the harness and /api/cron/status answered ${response.status} without it.`,
        "",
        "That means DATABASE_URL was overridden — almost certainly by a .env file — and",
        "posting webhooks at this server could write orders into a real merchant's database.",
      ].join("\n")
    );
  }
}

export async function startTestServer(options: { timeoutMs?: number } = {}): Promise<TestServer> {
  const db = await startTestDatabase();
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
