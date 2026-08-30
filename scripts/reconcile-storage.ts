import { list } from "@vercel/blob";
import { humanBytes } from "@/lib/storage/references";
import {
  runNightlyReconciliation,
  runAttributionSweep,
  type NightlyResult,
} from "@/lib/storage/reconcile";
import type { ProviderObject } from "@/lib/storage/drift";

// RECONCILIATION, RUN BY A PERSON:
//
//   npx tsx scripts/reconcile-storage.ts             # dry run, writes nothing
//   npx tsx scripts/reconcile-storage.ts --apply     # the nightly pass, for real
//   npx tsx scripts/reconcile-storage.ts --sweep     # + the weekly attribution sweep
//   npx tsx scripts/reconcile-storage.ts --selftest  # prove the comparison can see
//
// ============ THIS FILE NO LONGER DECIDES ANYTHING (2026-08-30) ========
//
// Every rule moved to lib/storage/reconcile.ts, because a cron has to call the
// same code an operator does and cannot call a script's main(). What is left
// here is argument parsing, a provider listing, and printing — the operator's
// front door to the module, exactly as the cron route is the timer's.
//
// The two must not drift into different behaviour, which is the whole reason
// the decisions live in one place rather than being implemented twice.

const APPLY = process.argv.includes("--apply");
const SWEEP = process.argv.includes("--sweep");
const SELFTEST = process.argv.includes("--selftest");

if (SELFTEST && APPLY) {
  console.log("--selftest cannot be combined with --apply. Its inputs are deliberately false.");
  process.exit(1);
}

async function listEverything(): Promise<{ objects: ProviderObject[]; truncated: boolean }> {
  const objects: ProviderObject[] = [];
  let cursor: string | undefined;
  for (let page = 0; ; page++) {
    if (page > 200) return { objects, truncated: true };
    const result = await list({ limit: 1000, cursor });
    objects.push(...result.blobs.map((b) => ({ pathname: b.pathname, url: b.url, size: b.size })));
    if (!result.hasMore || !result.cursor) break;
    cursor = result.cursor;
  }
  return { objects, truncated: false };
}

function report(result: NightlyResult): void {
  console.log("\n--- snapshot ---\n");
  console.log(`  provider   ${String(result.drift.provider.objects).padStart(4)} blobs  ${humanBytes(result.drift.provider.bytes).padStart(9)}`);
  console.log(`  ledger     ${String(result.drift.ledger.objects).padStart(4)} rows   ${humanBytes(result.drift.ledger.bytes).padStart(9)}`);
  console.log(`             ${result.drift.ledger.landed} landed, ${result.drift.ledger.reservations} live reservation(s)`);

  console.log("\n--- findings ---\n");
  if (result.drift.inSync && result.inconsistencies.length === 0) {
    console.log("  none. The ledger and the provider agree object for object and byte for byte.");
  } else {
    console.log(`  orphan blobs          ${result.orphans.total}  (${result.orphans.firstSeen} new, ${result.orphans.standing} standing)`);
    console.log(`  rows with no blob     ${result.drift.missingBlobs.length}  (${result.rowsRemoved} past the grace period)`);
    console.log(`  size disagreements    ${result.drift.sizeDisagreements.length}`);
    console.log(`  landed reservations   ${result.drift.landedReservations.length}`);
    for (const i of result.inconsistencies.slice(0, 20)) {
      console.log(`  ${i.corrected ? "corrected" : "REPORTED "}  ${i.pathname}\n              ${i.problem}`);
    }
    if (result.inconsistencies.length > 20) {
      console.log(`  ... and ${result.inconsistencies.length - 20} more ledger inconsistencies`);
    }
  }

  if (result.applied) {
    console.log("\n--- written ---\n");
    console.log(`  ${result.recovered} landed reservation(s) recovered`);
    console.log(`  ${result.rowsRemoved} row(s) removed for absent blobs`);
    console.log(`  ${result.sizesCorrected} size(s) corrected`);
    console.log(`  ${result.lastSeenTouched} row(s) marked seen`);
    console.log("\n  No blob was deleted. Reconciliation cannot delete one.");
  } else {
    console.log("\nDRY RUN — nothing written.");
  }
}

async function main(): Promise<void> {
  console.log(`\n${APPLY ? "APPLYING" : "DRY RUN"} — storage reconciliation, ${new Date().toISOString()}\n`);

  if (SELFTEST) {
    // ============ PROVING THE COMPARISON CAN SEE ====================
    //
    // A run against a healthy ledger reports nothing, and so does a comparison
    // that is silently blind. The two are indistinguishable from the output,
    // which makes a clean result worthless on its own. So the IN-MEMORY
    // provider snapshot is perturbed — never the database, never the provider —
    // and each classifier must fire.
    const real = await listEverything();
    if (real.objects.length < 2) {
      console.log("Not enough objects to perturb. Selftest needs at least two.");
      process.exitCode = 1;
      return;
    }
    const perturbed = [...real.objects];
    const dropped = perturbed.shift();
    perturbed[0] = { ...perturbed[0], size: perturbed[0].size + 4096 };
    perturbed.push({ pathname: "assets/selftest-orphan.png", url: "https://blob.test/selftest", size: 12345 });
    console.log(`SELFTEST — in memory only: removed ${dropped?.pathname}, grew ${perturbed[0].pathname} by 4096, invented an orphan\n`);

    const result = await runNightlyReconciliation({
      listObjects: async () => ({ objects: perturbed, truncated: false }),
      apply: false,
    });

    let bad = 0;
    const check = (name: string, ok: boolean) => { if (!ok) bad++; console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`); };
    console.log("--- selftest ---\n");
    check("a row whose blob vanished is seen", result.drift.missingBlobs.length === 1);
    check("a size disagreement is seen", result.drift.sizeDisagreements.length === 1);
    check("the correction takes the provider's figure", result.drift.sizeDisagreements[0]?.actual === result.drift.sizeDisagreements[0]?.recorded! + 4096);
    check("a blob with no row is seen", result.drift.orphanBlobs.length === 1);
    check("and nothing was written", result.applied === false);
    console.log(`\n  ${bad === 0 ? "The comparison can see. A clean run means agreement, not blindness." : `${bad} classifier(s) did not fire.`}`);
    process.exitCode = bad === 0 ? 0 : 1;
    return;
  }

  const result = await runNightlyReconciliation({ listObjects: listEverything, apply: APPLY });
  if (result.truncated) {
    console.log("STOP — the provider listing was truncated. Reconciling against a partial listing");
    console.log("would report every unseen blob as missing. Nothing was written.");
    process.exitCode = 1;
    return;
  }
  report(result);

  if (SWEEP) {
    console.log("\n--- weekly attribution sweep ---\n");
    const listing = await listEverything();
    const hosts = [...new Set(listing.objects.map((o) => new URL(o.url).host))];
    const sweep = await runAttributionSweep({ hosts, apply: APPLY });
    console.log(`  ${sweep.columnsScanned} columns scanned${sweep.columnsSkipped.length ? `, ${sweep.columnsSkipped.length} skipped` : ""}`);
    console.log(`  ${sweep.promoted} attribution(s) ${sweep.applied ? "promoted" : "would be promoted"}`);
    console.log(`  ${sweep.ownerChanged.length} owner change(s) SURFACED ONLY — a change of hands needs a person`);
    for (const c of sweep.ownerChanged.slice(0, 20)) console.log(`      ${c.pathname}: ${c.from} -> ${c.to}`);
    console.log(`  ${sweep.ownerReferenceGone} owner row(s) whose reference has since disappeared`);
    console.log("      (informational — an owner is never demoted for this; the file is still theirs)");
  }
}

void main();
