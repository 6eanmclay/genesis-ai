import { existsSync } from "fs";
import * as dotenv from "dotenv";

// WHICH TASKS ARE ACTUALLY WAITING ON THE OWNER, IN PRODUCTION:
//
//   npx tsx scripts/check-owner-blocked-tasks-production.ts .env.livecheck
//
// STRICTLY READ-ONLY. Every statement below is a SELECT. Nothing here writes a
// task, transitions a status, triggers a sweep, or reconciles anything. Same
// env-file argument as check-commerce-observations-production.ts so a live
// connection string never goes through shell history.
//
// WHY IT WAS RUN. The plan was "surface AWAITING_INPUT in NEEDS YOU". Before
// writing any of it: does that status exist in the data, and if it does not, is
// there real owner-blocked work wearing a different status? Counting is the
// only way to know which question is the real one.
//
// WHAT IT FOUND, 2026-09-15:
//
//   AWAITING_INPUT          0 rows, and no writer anywhere in the codebase
//   requiredInput, active   0 rows (its writer, raiseEconomicsQuestions, is real
//                           and live — it simply has not fired for these stores)
//   IN_PROGRESS             2 rows, handed to J4 38 and 39 days earlier, and
//                           invisible on every surface the owner has
//
// So the status named in the plan was a phantom and the resumption defect was
// real, one status over — which is what getActiveTasks was changed to fix.
//
// NOTHING HERE INTERPRETS. Every number is counted and a zero is reported as a
// zero rather than as an absence.

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

async function main() {
  const { prismaSystem: prisma } = await import("@/lib/prisma");

  // Host only, credentials stripped — same as every other production check.
  const host = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/\/.*$/, "");
  console.log(`Database host: ${host}\n`);

  // ====================================================================
  console.log("=== 1. EVERY TASK, BY STATUS ===\n");
  // ====================================================================
  const byStatus = await prisma.$queryRawUnsafe<{ status: string; n: bigint }[]>(
    `SELECT status, COUNT(*)::bigint AS n FROM "Task" GROUP BY status ORDER BY n DESC`,
  );
  for (const row of byStatus) console.log(`    ${String(row.n).padStart(6)}  ${row.status}`);
  const awaiting = byStatus.find((r) => r.status === "AWAITING_INPUT");
  console.log(`\n    AWAITING_INPUT rows: ${awaiting ? String(awaiting.n) : "0"}`);

  // ====================================================================
  console.log("\n=== 2. NON-TERMINAL TASKS CARRYING requiredInput ===\n");
  // ====================================================================
  //
  // requiredInput is the field that names what the owner still owes. A row
  // carrying it is blocked on a person whatever its status column says.
  const blocked = await prisma.$queryRawUnsafe<
    { source: string; status: string; n: bigint; with_href: bigint }[]
  >(
    `SELECT source, status, COUNT(*)::bigint AS n,
            COUNT(*) FILTER (WHERE "actionHref" IS NOT NULL)::bigint AS with_href
       FROM "Task"
      WHERE "requiredInput" IS NOT NULL
        AND status NOT IN ('COMPLETED','DISMISSED')
      GROUP BY source, status
      ORDER BY n DESC`,
  );
  if (blocked.length === 0) console.log("    (none)");
  for (const row of blocked) {
    console.log(
      `    ${String(row.n).padStart(4)}  ${row.source.padEnd(28)} ${row.status.padEnd(14)} with actionHref: ${row.with_href}`,
    );
  }

  // ====================================================================
  console.log("\n=== 3. WHAT THE OFFICE ACTUALLY READS ===\n");
  // ====================================================================
  //
  // Before 2026-09-15 the one owner-facing task query filtered status = 'OPEN',
  // so anything in another non-terminal status was absent from the Office.
  const officeVisible = await prisma.$queryRawUnsafe<{ status: string; n: bigint }[]>(
    `SELECT status, COUNT(*)::bigint AS n
       FROM "Task"
      WHERE status NOT IN ('COMPLETED','DISMISSED')
      GROUP BY status ORDER BY n DESC`,
  );
  for (const row of officeVisible) {
    const seen = "read by the Office";
    console.log(`    ${String(row.n).padStart(6)}  ${row.status.padEnd(14)} ${seen}`);
  }

  // ====================================================================
  console.log("\n=== 4. EVERY NON-TERMINAL TASK, ONE BY ONE ===\n");
  // ====================================================================
  //
  // Titles and task metadata only. No message bodies, no customer data.
  // `seedMessageId` is the fact that says the owner handed this to J4 — it is
  // written by startTaskConversation in the same statement as IN_PROGRESS.
  const rows = await prisma.$queryRawUnsafe<
    {
      title: string;
      status: string;
      source: string;
      actionType: string | null;
      trustLevel: string;
      priority: string;
      actionHref: string | null;
      has_seed: boolean;
      has_required: boolean;
      createdAt: Date;
      updatedAt: Date;
    }[]
  >(
    `SELECT title, status, source, "actionType", "trustLevel", priority, "actionHref",
            ("seedMessageId" IS NOT NULL) AS has_seed,
            ("requiredInput" IS NOT NULL) AS has_required,
            "createdAt", "updatedAt"
       FROM "Task"
      WHERE status NOT IN ('COMPLETED','DISMISSED')
      ORDER BY "createdAt" ASC
      LIMIT 40`,
  );
  if (rows.length === 0) console.log("    (none)");
  for (const r of rows) {
    const age = Math.floor((Date.now() - r.createdAt.getTime()) / 86_400_000);
    const idle = Math.floor((Date.now() - r.updatedAt.getTime()) / 86_400_000);
    console.log(`    "${r.title}"`);
    console.log(
      `        ${r.status} / ${r.source} / actionType=${r.actionType ?? "null"} / trust=${r.trustLevel} / priority=${r.priority}`,
    );
    console.log(
      `        actionHref=${r.actionHref ?? "null"}  seedMessage=${r.has_seed}  requiredInput=${r.has_required}`,
    );
    console.log(`        raised ${age} days ago, last touched ${idle} days ago`);
  }

  // ====================================================================
  console.log("\n=== 5. EVERY ACTIVE TASK'S DESTINATION ===\n");
  // ====================================================================
  //
  // officeActionForTask has exactly one input: actionHref. Without one the row
  // is "none" and lands in NOTICED, whatever the work actually is.
  const hrefs = await prisma.$queryRawUnsafe<{ has_href: boolean; n: bigint }[]>(
    `SELECT ("actionHref" IS NOT NULL) AS has_href, COUNT(*)::bigint AS n
       FROM "Task" WHERE status = 'OPEN' GROUP BY 1`,
  );
  for (const row of hrefs) {
    console.log(`    ${String(row.n).padStart(6)}  ${row.has_href ? "has a destination" : "no destination -> NOTICED"}`);
  }

  // ====================================================================
  console.log("\n=== 6. DOES ANYTHING EVER LEAVE IN_PROGRESS? ===\n");
  // ====================================================================
  //
  // If a resumed task can only end by being completed, then one the owner
  // never finishes is invisible permanently rather than temporarily.
  const ended = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT COUNT(*)::bigint AS n FROM "Task"
      WHERE "seedMessageId" IS NOT NULL AND status IN ('COMPLETED','DISMISSED')`,
  );
  console.log(`    tasks that were handed to J4 and later finished: ${String(ended[0]?.n ?? 0)}`);
  const stuck = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT COUNT(*)::bigint AS n FROM "Task"
      WHERE "seedMessageId" IS NOT NULL AND status = 'IN_PROGRESS'`,
  );
  console.log(`    tasks handed to J4 and still unfinished:        ${String(stuck[0]?.n ?? 0)}`);

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
});
