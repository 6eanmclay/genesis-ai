import { spawnSync } from "node:child_process";

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

const unpooled = process.env.DATABASE_URL_UNPOOLED;
const env = { ...process.env };

if (unpooled) {
  env.DATABASE_URL = unpooled;
  console.log("migrate: using DATABASE_URL_UNPOOLED (direct connection)");
} else {
  console.log("migrate: DATABASE_URL_UNPOOLED not set, falling back to DATABASE_URL");
}

// Via npx so this works whether it is invoked through `npm run build` (where
// node_modules/.bin is already on PATH) or directly with `node`. npx resolves
// the locally installed prisma without reaching the network.
const result = spawnSync("npx", ["prisma", "migrate", "deploy"], {
  stdio: "inherit",
  env,
  shell: true,
});

process.exit(result.status ?? 1);
