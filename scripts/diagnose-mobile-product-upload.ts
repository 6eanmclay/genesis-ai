import "dotenv/config";
import { prismaSystem } from "../lib/prisma";

// Real-evidence diagnosis (2026-08-08) — Sean confirmed the photo is
// selectable on mobile, failure happens on submit. execute()
// (lib/execution/engine.ts) never throws for a business-logic failure —
// it catches everything internally and persists a real FAILED
// ExecutionLog row with the actual thrown message, then returns that
// result rather than re-throwing. Read-only query against real production
// evidence rather than guessing which of (wrong format / too large /
// something else) is actually happening.
async function main() {
  const rows = await prismaSystem.executionLog.findMany({
    where: { action: "product.create" },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { id: true, storeId: true, status: true, message: true, retryable: true, createdAt: true, actorType: true },
  });

  if (rows.length === 0) {
    console.log("No product.create ExecutionLog rows found at all.");
    return;
  }

  for (const row of rows) {
    console.log(`[${row.createdAt.toISOString()}] status=${row.status} store=${row.storeId} actor=${row.actorType} message=${JSON.stringify(row.message)}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prismaSystem.$disconnect());
