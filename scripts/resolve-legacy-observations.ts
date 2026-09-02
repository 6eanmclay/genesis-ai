import * as dotenv from "dotenv";

// RETIRE ONE LEGACY OBSERVATION THAT NOTHING CAN EVER RETRACT.
//
//   npx tsx scripts/resolve-legacy-observations.ts path/to/production.env <observationId>          # dry run
//   npx tsx scripts/resolve-legacy-observations.ts path/to/production.env <observationId> --apply  # writes
//
// ============ WHAT IS WRONG WITH THESE ROWS ==========================
//
// resolveMissingObservations scopes every retraction with
// `dedupeKey: { startsWith: <prefix> }`. A GenesisObservation written before
// its producer had a prefix is therefore owned by no producer and can never be
// resolved by anything. Eight such rows exist in production; six are still
// ACTIVE, the oldest last confirmed 36 days ago.
//
// They are NOT uniformly wrong, which is the whole reason this is one row at a
// time and not a sweep. Four are demonstrably false, one is still perfectly
// true, and one is an editorial judgment nobody but the owner can settle. See
// BI_ENGINE.md section 21 for the classification and the evidence behind each.
//
// ============ RESOLVED, NOT DELETED ==================================
//
// Every other model in this codebase supersedes or resolves by status, and
// GenesisObservation already has RESOLVED with a resolvedAt to record when.
// Deleting would destroy the record that J4 once believed this, which is the
// history the Learn stage reasons over. So this sets exactly the two fields
// the ordinary resolution path sets, and nothing else.
//
// ============ ONE ID, NEVER A LIST ===================================
//
// There is no --all and no prefix mode. Six rows across three businesses is
// not a job; each one is a decision Sean has made individually, and a bulk
// mode would let the one that is still true go with the rest.
//
// NOT RUN WITHOUT SEAN'S APPROVAL OF THE SPECIFIC ROW. See EXTERNAL_BLOCKERS.md
// E21.

dotenv.config({ path: process.argv[2], override: true });

const observationId = process.argv[3];
const apply = process.argv.includes("--apply");

async function main(): Promise<void> {
  if (!process.argv[2] || !observationId || observationId.startsWith("--")) {
    console.error("usage: resolve-legacy-observations.ts <env-file> <observationId> [--apply]");
    process.exitCode = 1;
    return;
  }

  const { prismaSystem } = await import("@/lib/prisma");

  const row = await prismaSystem.genesisObservation.findUnique({
    where: { id: observationId },
    select: {
      id: true, storeId: true, dedupeKey: true, genesisState: true, status: true,
      summary: true, firstNoticedAt: true, lastConfirmedAt: true, resolvedAt: true,
      store: { select: { slug: true } },
    },
  });

  if (!row) {
    console.error(`No observation ${observationId}. Nothing written.`);
    process.exitCode = 1;
    return;
  }

  // THE GUARD THAT MAKES THIS SAFE TO RUN TWICE, and the one that stops it
  // being pointed at a healthy row by mistake: a prefixed dedupeKey belongs to
  // a live producer, and that producer will resolve it on its own schedule.
  // Retiring one by hand would be taking a decision away from the sweep that
  // owns it.
  if (row.dedupeKey.includes(":")) {
    console.error(
      `Refusing: "${row.dedupeKey}" is prefixed, so a producer already owns it ` +
        `and will resolve it when the condition stops being true. This script is ` +
        `only for the prefix-less legacy rows nothing can reach.`
    );
    process.exitCode = 1;
    return;
  }

  const days = Math.floor((Date.now() - row.lastConfirmedAt.getTime()) / 86_400_000);
  console.log("");
  console.log("  observation  " + row.id);
  console.log("  business     " + (row.store?.slug ?? row.storeId));
  console.log("  dedupeKey    " + row.dedupeKey + "   (prefix-less — unreachable by any producer)");
  console.log("  state        " + row.genesisState + " / " + row.status);
  console.log("  confirmed    " + row.lastConfirmedAt.toISOString().slice(0, 10) + "  — " + days + " days ago");
  console.log("  resolvedAt   " + String(row.resolvedAt));
  console.log("  summary      " + row.summary.slice(0, 140));

  if (row.status !== "ACTIVE") {
    console.log("\n  Already " + row.status + ". Nothing to do.");
    return;
  }

  if (!apply) {
    console.log("\n  DRY RUN. Would set status=RESOLVED and resolvedAt=now. Nothing was written.");
    console.log("  Add --apply to write it.");
    return;
  }

  // Conditional on still being ACTIVE, so a concurrent resolution wins rather
  // than being overwritten with a second, later timestamp.
  const result = await prismaSystem.genesisObservation.updateMany({
    where: { id: row.id, storeId: row.storeId, status: "ACTIVE" },
    data: { status: "RESOLVED", resolvedAt: new Date() },
  });
  console.log("\n  rows updated: " + result.count);

  const after = await prismaSystem.genesisObservation.findUnique({
    where: { id: row.id },
    select: { status: true, resolvedAt: true },
  });
  console.log("  now: " + JSON.stringify(after));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error((error as Error)?.message ?? String(error));
    process.exit(1);
  });
