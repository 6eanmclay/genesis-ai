import { prismaSystem } from "@/lib/prisma";

// WHAT THE FIRST CRON RUN AFTER THIS DEPLOY WOULD ACTUALLY TOUCH — READ ONLY.
//
//   npx tsx scripts/deploy-impact.ts
//
// ============ WHY THIS IS NOT A CODE REVIEW ===========================
//
// Reading the scheduler tells you which tasks would run. It does not tell you
// whether any of them would find anything, and "this task can delete rows" and
// "this task would delete 400 of your rows tomorrow morning" are different
// facts for the person deciding whether to deploy.
//
// So this counts, against the real database, exactly what each newly-enabled
// task would select. It writes nothing and has no apply path.
//
// RAW SQL because the deployed database is ten migrations behind this branch;
// the generated client asks for columns and tables production has never had.

type Row = Record<string, unknown>;

async function tableExists(name: string): Promise<boolean> {
  const rows = await prismaSystem.$queryRawUnsafe<Row[]>(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
    name,
  );
  return rows.length > 0;
}

async function count(sql: string, ...params: unknown[]): Promise<number> {
  const rows = await prismaSystem.$queryRawUnsafe<{ n: bigint }[]>(sql, ...params);
  return Number(rows[0]?.n ?? 0);
}

async function main(): Promise<void> {
  console.log("\nWhat the first daily cron after this deploy would find.\n");

  // ---- tasks that are NEW to the cron and touch pre-existing tables -----
  console.log("NEW tasks that reach tables production already has:");

  const HOUR = 60 * 60 * 1000;
  if (await tableExists("TemporaryAsset")) {
    const total = await count(`SELECT count(*)::bigint AS n FROM "TemporaryAsset"`);
    const wouldDelete = await count(
      `SELECT count(*)::bigint AS n FROM "TemporaryAsset"
        WHERE "promotedAt" IS NULL AND "createdAt" < $1`,
      new Date(Date.now() - HOUR),
    );
    const promoted = await count(
      `SELECT count(*)::bigint AS n FROM "TemporaryAsset" WHERE "promotedAt" IS NOT NULL`,
    );
    console.log(`  storage.temporaryAssets   ${total} rows total, ${promoted} promoted (exempt)`);
    console.log(`                            WOULD DELETE ${wouldDelete} row(s) and their blobs, capped at 200/run`);
  } else {
    console.log("  storage.temporaryAssets   table does not exist in production");
  }

  if (await tableExists("ProductEvent")) {
    const total = await count(`SELECT count(*)::bigint AS n FROM "ProductEvent"`);
    console.log(`  telemetry.prune           ${total} ProductEvent rows — DRY RUN, deletes 0`);
  }

  if (await tableExists("Order")) {
    // orders.notifications claims-then-sends. With no RESEND_API_KEY the send
    // is refused before anything is claimed, so this is what it would consider
    // rather than what it would change.
    const unnotified = await count(
      `SELECT count(*)::bigint AS n FROM "Order" WHERE "confirmationSentAt" IS NULL AND "status" = 'paid'`,
    );
    console.log(`  orders.notifications      ${unnotified} paid order(s) never confirmed to the customer`);
    console.log(`                            no RESEND_API_KEY, so nothing is sent and no claim is kept`);
  }

  console.log("\nNEW tasks whose tables arrive empty with this deploy:");
  for (const [task, table] of [
    ["queue.drain", "Job"],
    ["webhooks.releaseStaleReplays", "WebhookDelivery"],
    ["security.prune", "SecuritySignal"],
    ["retention.sweep", "OutboundOperation"],
  ] as const) {
    const exists = await tableExists(table);
    console.log(`  ${task.padEnd(28)} ${table} ${exists ? "ALREADY EXISTS — check it" : "created by this deploy, so empty"}`);
  }

  console.log("\nTasks the cron already runs today (unchanged by this deploy):");
  for (const [task, table] of [
    ["auth.pruneAttempts", "AuthAttempt"],
    ["intelligence.syncs", "Store"],
    ["growthPoints.refresh", "Store"],
    ["sourcing.discovery", "SourcedProduct"],
  ] as const) {
    const n = (await tableExists(table)) ? await count(`SELECT count(*)::bigint AS n FROM "${table}"`) : -1;
    console.log(`  ${task.padEnd(28)} ${table}: ${n < 0 ? "no such table" : `${n} rows`}`);
  }

  console.log("\nThe data that must not move:");
  for (const table of ["Order", "OrderItem", "Store", "User", "Product"]) {
    const n = (await tableExists(table)) ? await count(`SELECT count(*)::bigint AS n FROM "${table}"`) : -1;
    console.log(`  ${table.padEnd(12)} ${n < 0 ? "no such table" : `${n} rows`}`);
  }
  console.log("");

  await prismaSystem.$disconnect();
}

void main();
