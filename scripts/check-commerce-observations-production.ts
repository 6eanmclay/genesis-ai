import { existsSync } from "fs";
import * as dotenv from "dotenv";

// WHAT THE NATURAL CRON ACTUALLY PRODUCED FOR COMMERCE:
//
//   npx tsx scripts/check-commerce-observations-production.ts .env.livecheck
//
// STRICTLY READ-ONLY. Every statement below is a SELECT, and getCommerce
// Conditions is documented as a pure read — "it writes nothing, so it can be
// called to inspect a store without changing what J4 is saying about it."
// Nothing here triggers the cron, writes an observation, resolves one, or
// reconciles anything. Same env-file argument as check-promotions-production.ts
// so a live connection string never goes through shell history.
//
// NOTHING HERE INTERPRETS. Every number is counted and a zero is reported as a
// zero rather than as an absence. The classification is a person's job.

const envFile = process.argv[2];
if (envFile) {
  if (!existsSync(envFile)) {
    console.error(`No such env file: ${envFile}`);
    process.exit(1);
  }
  dotenv.config({ path: envFile, override: true });
  console.log(`Loaded environment from: ${envFile}\n`);
} else {
  dotenv.config();
  console.log("No env file named — this is almost certainly your DEV database.\n");
}

const FAMILIES = [
  "commerce:orders_unfulfilled_stale",
  "commerce:orders_shipped_untracked",
  "commerce:receipts_unsent",
  "commerce:payment_connection_broken",
] as const;

async function main() {
  const { prismaSystem: prisma } = await import("@/lib/prisma");
  const { getCommerceConditions } = await import("@/lib/commerce/conditions");

  // Host only, credentials stripped — same as every other production check here.
  const host = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/\/.*$/, "");
  console.log(`Database host: ${host}\n`);

  // ====================================================================
  console.log("=== 1. DEPLOYMENT / MIGRATION STATE ===\n");
  // ====================================================================
  const migrations = await prisma.$queryRawUnsafe<
    { migration_name: string; finished_at: Date | null }[]
  >(`SELECT migration_name, finished_at FROM "_prisma_migrations"
     ORDER BY finished_at DESC NULLS FIRST LIMIT 6`);
  for (const m of migrations) {
    console.log(`    ${m.finished_at ? m.finished_at.toISOString().slice(0, 19) : "UNFINISHED".padEnd(19)}  ${m.migration_name}`);
  }
  const target = "20260914120000_store_created_from_draft";
  const landed = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT COUNT(*)::bigint AS n FROM "_prisma_migrations" WHERE migration_name = $1 AND finished_at IS NOT NULL`,
    target,
  );
  console.log(`\n    ${target}: ${Number(landed[0].n) > 0 ? "APPLIED" : "NOT APPLIED"}`);
  const hasColumn = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT COUNT(*)::bigint AS n FROM information_schema.columns
     WHERE table_name = 'Store' AND column_name = 'createdFromDraftId'`,
  );
  console.log(`    Store.createdFromDraftId column present: ${Number(hasColumn[0].n) > 0}`);

  // ====================================================================
  console.log("\n=== 2. DID THE NATURAL CYCLE RUN? ===\n");
  // ====================================================================
  const runs = await prisma.$queryRawUnsafe<
    { taskKey: string; outcome: string; startedAt: Date; durationMs: number | null }[]
  >(`SELECT "taskKey", outcome, "startedAt", "durationMs" FROM "ScheduledTaskRun"
     WHERE "startedAt" >= NOW() - INTERVAL '36 hours'
     ORDER BY "startedAt" DESC LIMIT 25`);
  if (runs.length === 0) console.log("    (no scheduled task runs in the last 36 hours)");
  for (const r of runs) {
    console.log(`    ${r.startedAt.toISOString().slice(0, 19)}  ${r.taskKey.padEnd(28)} ${r.outcome.padEnd(10)} ${r.durationMs ?? "—"}ms`);
  }

  // ====================================================================
  console.log("\n=== 3. COMMERCE OBSERVATIONS ON FILE ===\n");
  // ====================================================================
  const observations = await prisma.genesisObservation.findMany({
    where: { dedupeKey: { startsWith: "commerce:" } },
    orderBy: [{ storeId: "asc" }, { dedupeKey: "asc" }],
    select: {
      id: true, storeId: true, dedupeKey: true, genesisState: true, summary: true,
      actionHref: true, status: true, firstNoticedAt: true, lastConfirmedAt: true,
      resolvedAt: true, dismissedAt: true, recordId: true, entityType: true,
      store: { select: { name: true, slug: true } },
    },
  });
  console.log(`    TOTAL commerce observation rows: ${observations.length}`);
  const storeIds = [...new Set(observations.map((o) => o.storeId))];
  console.log(`    distinct stores with any:        ${storeIds.length}\n`);

  for (const family of FAMILIES) {
    const rows = observations.filter((o) => o.dedupeKey === family);
    const active = rows.filter((r) => r.status === "ACTIVE").length;
    console.log(
      `    ${family.padEnd(40)} rows=${String(rows.length).padStart(2)}  ACTIVE=${String(active).padStart(2)}  ` +
        `RESOLVED=${rows.filter((r) => r.status === "RESOLVED").length}  DISMISSED=${rows.filter((r) => r.status === "DISMISSED").length}`,
    );
  }
  const unknown = observations.filter((o) => !(FAMILIES as readonly string[]).includes(o.dedupeKey));
  console.log(`    ${"(any other commerce: key)".padEnd(40)} rows=${unknown.length}`);
  for (const o of unknown) console.log(`        unexpected key: ${o.dedupeKey}`);

  // ====================================================================
  console.log("\n=== 4. EVERY ROW, WITH ITS IDENTITY AND EVIDENCE FIELDS ===\n");
  // ====================================================================
  for (const o of observations) {
    console.log(`    ${o.store.slug} — ${o.store.name}`);
    console.log(`        dedupeKey      ${o.dedupeKey}`);
    console.log(`        state/status   ${o.genesisState} / ${o.status}`);
    console.log(`        recordId       ${o.recordId ?? "NULL"}`);
    console.log(`        entityType     ${o.entityType ?? "NULL"}`);
    console.log(`        actionHref     ${o.actionHref ?? "NULL"}`);
    console.log(`        firstNoticed   ${o.firstNoticedAt.toISOString().slice(0, 19)}`);
    console.log(`        lastConfirmed  ${o.lastConfirmedAt.toISOString().slice(0, 19)}`);
    console.log(`        summary        ${o.summary}`);
  }
  const missingRecordId = observations.filter((o) => o.recordId === null).length;
  console.log(`\n    rows with recordId NULL: ${missingRecordId} of ${observations.length}`);
  console.log(`    rows with entityType NULL: ${observations.filter((o) => o.entityType === null).length} of ${observations.length}`);

  // ====================================================================
  console.log("\n=== 5. THE EVIDENCE THE CONDITION ACTUALLY HAS ===\n");
  // ====================================================================
  //
  // getCommerceConditions returns orderIds — which orders make each condition
  // true. This asks it for every store that has a commerce observation, to see
  // what evidence exists at read time versus what was persisted.
  for (const storeId of storeIds) {
    const store = observations.find((o) => o.storeId === storeId)!.store;
    const conditions = await getCommerceConditions(storeId);
    console.log(`    ${store.slug}:`);
    if (conditions.length === 0) console.log("        (no conditions true right now)");
    for (const c of conditions) {
      console.log(`        ${c.dedupeKey.padEnd(38)} orderIds=${c.orderIds.length}  ${c.orderIds.slice(0, 6).join(", ")}${c.orderIds.length > 6 ? ", …" : ""}`);
    }
  }

  // ====================================================================
  console.log("\n=== 6. STORES THAT COULD HAVE RECEIVED ONE ===\n");
  // ====================================================================
  const allStores = await prisma.store.findMany({
    select: { id: true, slug: true, name: true, _count: { select: { orders: true } } },
    orderBy: { createdAt: "asc" },
  });
  console.log(`    total stores on the platform: ${allStores.length}`);
  for (const s of allStores) {
    const mine = observations.filter((o) => o.storeId === s.id);
    console.log(
      `    ${s.slug.padEnd(28)} orders=${String(s._count.orders).padStart(3)}  commerceObservations=${mine.length}` +
        (mine.length ? `  [${mine.map((m) => m.dedupeKey.replace("commerce:", "")).join(", ")}]` : ""),
    );
  }

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
});
