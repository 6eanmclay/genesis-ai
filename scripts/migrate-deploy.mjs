import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migrationDecision, refusalMessage, ALLOW_VARIABLE } from "./lib/migrationGate.mjs";

// Runs `prisma migrate deploy` on the UNPOOLED connection (2026-08-17).
//
// Why this exists rather than a shell one-liner in package.json: the build
// script has to work on Vercel (Linux) and on a Windows dev machine, and
// `VAR=x cmd` is not valid on the latter. A tiny Node wrapper is the only
// portable way to set one env var for one command.
//
// WHY IT MATTERS. `prisma migrate deploy` takes a session-scoped Postgres
// advisory lock. Through Neon's pooler (pgbouncer) a session can be recycled
// out from under that lock, so the lock outlives the process that took it and
// nothing ever releases it. Every subsequent build then dies with:
//
//   Error: P1002 — Timed out trying to acquire a postgres advisory lock
//
// which is exactly what happened here: two stranded pgbouncer sessions held
// lock 72707369 and blocked deploys until they aged out. Migrations belong on
// a direct connection; the app itself still uses the pooled one, which is what
// pooling is actually for.
//
// Falls back to DATABASE_URL when DATABASE_URL_UNPOOLED is not set, so a local
// machine or any environment without the direct URL behaves exactly as before
// rather than failing to migrate at all.
//
// ============ AND SINCE 2026-09-17, IT ASKS PERMISSION FIRST ===========
//
// U7, Sean's decision: "I do not want schema migrations reaching production
// automatically without a review checkpoint." The judgement lives in
// scripts/lib/migrationGate.mjs — pure, and proven by verify-migration-gate.
// This file supplies the facts and carries out the answer. Everything above
// about the unpooled connection is unchanged and matters more than ever, since
// the deliberate path uses it too.

const unpooled = process.env.DATABASE_URL_UNPOOLED;
const env = { ...process.env };

if (unpooled) {
  env.DATABASE_URL = unpooled;
  console.log("migrate: using DATABASE_URL_UNPOOLED (direct connection)");
} else {
  console.log("migrate: DATABASE_URL_UNPOOLED not set, falling back to DATABASE_URL");
}

/** Every migration directory this repository carries, in order. */
function migrationsOnDisk() {
  const dir = fileURLToPath(new URL("../prisma/migrations/", import.meta.url));
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * Which of those the database has not finished applying.
 *
 * READ FROM THE LEDGER, NOT FROM `prisma migrate status` OUTPUT. Parsing a
 * CLI's prose for a phrase like "have not yet been applied" is a promise nobody
 * made, and it would break silently the day the wording changes — the exact
 * class of defect this repository keeps finding, most recently a lane
 * classifier that read comments as code. The migrations directory and the
 * _prisma_migrations table are both facts, and comparing them is arithmetic.
 *
 * A DATABASE THAT CANNOT BE REACHED IS NOT A DATABASE WITH NOTHING PENDING.
 * It fails the build rather than letting it past on an unanswered question.
 */
async function pendingMigrations(connectionString) {
  const client = new pg.Client({ connectionString });
  try {
    await client.connect();
    const { rows } = await client.query(
      `SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
    );
    const applied = new Set(rows.map((r) => r.migration_name));
    return migrationsOnDisk().filter((name) => !applied.has(name));
  } finally {
    await client.end().catch(() => {});
  }
}

const vercelEnv = process.env.VERCEL_ENV;
const allow = process.env[ALLOW_VARIABLE];

// Only a production deploy needs the ledger read at all. Everywhere else
// migrates regardless, so asking would be a round trip to learn something that
// changes nothing.
let pending = [];
if (vercelEnv === "production") {
  try {
    pending = await pendingMigrations(env.DATABASE_URL);
  } catch (error) {
    console.error("migrate: could not read the migration ledger, so the gate cannot be answered.");
    console.error(String(error instanceof Error ? error.message : error));
    process.exit(1);
  }
}

const decision = migrationDecision({ vercelEnv, allow, pending });

if (decision.action === "refuse") {
  console.error(refusalMessage({ pending, why: decision.why }));
  process.exit(1);
}

if (decision.action === "skip") {
  console.log(`migrate: ${decision.why} — nothing to do`);
  process.exit(0);
}

console.log(`migrate: proceeding — ${decision.why}`);

// Via npx so this works whether it is invoked through `npm run build` (where
// node_modules/.bin is already on PATH) or directly with `node`. npx resolves
// the locally installed prisma without reaching the network.
const result = spawnSync("npx", ["prisma", "migrate", "deploy"], {
  stdio: "inherit",
  env,
  shell: true,
});

process.exit(result.status ?? 1);
