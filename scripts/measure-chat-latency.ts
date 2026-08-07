import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// Read-only production measurement — Response Modes plan, Phase 0.
// Queries the real chat.turn_completed ProductEvent rows (stageDurationsMs
// instrumentation landed same day, commit 366a109) to get real per-stage
// p50/p90 latency before any architecture change, per this project's
// "investigate before fixing" discipline. Not meant to be re-run as part
// of any build — a one-off analysis script, kept for the record.

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function main() {
  const events = await prisma.productEvent.findMany({
    where: { name: "chat.turn_completed" },
    select: { durationMs: true, outcome: true, metadata: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: 2000,
  });

  console.log(`Total chat.turn_completed rows fetched: ${events.length}`);
  if (events.length === 0) {
    console.log("No rows yet — instrumentation may not have collected real traffic since landing.");
    return;
  }

  const overall = events.map((e) => e.durationMs).filter((d): d is number => typeof d === "number").sort((a, b) => a - b);
  console.log("\n=== Overall turn duration (ms) ===");
  console.log(`count=${overall.length} p50=${percentile(overall, 50)} p90=${percentile(overall, 90)} max=${overall[overall.length - 1]}`);

  const successCount = events.filter((e) => e.outcome === "success").length;
  const failureCount = events.filter((e) => e.outcome === "failure").length;
  console.log(`success=${successCount} failure=${failureCount}`);

  const stageBuckets: Record<string, number[]> = {};
  for (const e of events) {
    const meta = e.metadata as { stageDurationsMs?: Record<string, number | null> } | null;
    const stages = meta?.stageDurationsMs;
    if (!stages) continue;
    for (const [stage, ms] of Object.entries(stages)) {
      if (typeof ms !== "number") continue;
      (stageBuckets[stage] ??= []).push(ms);
    }
  }

  console.log("\n=== Per-stage duration (ms), rows where that stage actually ran ===");
  for (const [stage, values] of Object.entries(stageBuckets)) {
    const sorted = values.sort((a, b) => a - b);
    console.log(
      `${stage.padEnd(16)} n=${String(sorted.length).padEnd(5)} p50=${String(percentile(sorted, 50)).padEnd(6)} p90=${String(percentile(sorted, 90)).padEnd(6)} max=${sorted[sorted.length - 1]}`
    );
  }

  const withStageData = events.filter((e) => (e.metadata as { stageDurationsMs?: unknown } | null)?.stageDurationsMs);
  console.log(`\nRows with stageDurationsMs populated: ${withStageData.length} / ${events.length}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
