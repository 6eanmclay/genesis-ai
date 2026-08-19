import { prismaSystem } from "@/lib/prisma";
import { planTopicKeyBackfill, deriveTopicKey } from "@/lib/intelligence/topicKeys";

// Business Intelligence Engine M2 — the topicKey backfill.
//
//   npx tsx scripts/backfill-topic-keys.ts           dry run, writes nothing
//   npx tsx scripts/backfill-topic-keys.ts --apply   writes the derived keys
//
// WHAT IT IS ALLOWED TO DO, exactly: add a topicKey to a decision that has
// none. Nothing else. The update below sets one field, and the plan it acts on
// (planTopicKeyBackfill) can only produce { id, topicKey } — so the decision,
// its provenance, its timestamps, its actor, its approval outcome and its input
// are unreachable from here, by type rather than by promise.
//
// NO AI, NO INFERENCE. Every key comes from deriveTopicKey reading only
// actionType and the already-recorded input. Classifying a historical decision
// with a model would be inventing information about the past.
//
// AMBIGUOUS ROWS ARE LEFT ALONE. A wrong key is worse than no key: it merges
// unrelated decisions into one false pattern, and beliefs are formed by
// counting. Rows that already have a key are never rewritten, so this is
// idempotent and can never overwrite one the model authored.

const APPLY = process.argv.includes("--apply");

async function main(): Promise<void> {
  const rows = await prismaSystem.approvalRequest.findMany({
    where: { topicKey: null },
    select: { id: true, storeId: true, actionType: true, input: true, topicKey: true, status: true },
    orderBy: { createdAt: "asc" },
  });

  console.log(`Decisions with no topicKey: ${rows.length}`);
  if (rows.length === 0) return;

  const updates = planTopicKeyBackfill(rows);
  const byId = new Map(updates.map((u) => [u.id, u.topicKey]));

  const derivedCounts = new Map<string, number>();
  const skippedCounts = new Map<string, number>();
  for (const row of rows) {
    const key = byId.get(row.id);
    const bucket = key ? derivedCounts : skippedCounts;
    const label = key ?? row.actionType;
    bucket.set(label, (bucket.get(label) ?? 0) + 1);
  }

  console.log(`\nDerivable: ${updates.length}`);
  for (const [key, n] of [...derivedCounts].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${key}`);
  }

  console.log(`\nAmbiguous — left null: ${rows.length - updates.length}`);
  for (const [actionType, n] of [...skippedCounts].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${actionType}`);
  }

  // A visible, checkable sample rather than a bare count — the point of a dry
  // run is that someone can disagree with a specific mapping before it lands.
  console.log("\nSample:");
  for (const row of rows.slice(0, 8)) {
    const key = deriveTopicKey(row.actionType, row.input);
    console.log(`  ${row.status.padEnd(17)} ${row.actionType.padEnd(22)} -> ${key ?? "(left null)"}`);
  }

  if (!APPLY) {
    console.log("\nDry run. Nothing was written. Re-run with --apply to write these keys.");
    return;
  }

  let written = 0;
  for (const row of rows) {
    const topicKey = byId.get(row.id);
    if (!topicKey) continue;
    // updateMany with a flat storeId satisfies lib/tenantIsolation.ts, which
    // refuses an unscoped write on a tenant-owned table. `topicKey: null` in
    // the filter makes this safe to re-run: a row that somehow gained a key
    // between the read and the write is not overwritten.
    const result = await prismaSystem.approvalRequest.updateMany({
      where: { id: row.id, storeId: row.storeId, topicKey: null },
      data: { topicKey },
    });
    written += result.count;
  }
  console.log(`\nWrote ${written} topic keys. No other field was modified.`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
