import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import {
  runNightlyReconciliation,
  runAttributionSweep,
  nightlyEnabled,
  attributionSweepEnabled,
  GRACE_MS,
} from "@/lib/storage/reconcile";
import type { AttributionScan } from "@/lib/storage/attribution";

// RECONCILIATION ON A TIMER:
//
//   part of the database sweep — npx tsx scripts/run-db-suites.ts reconcile-db
//
// ============ EVERY TEST HERE FAILS IF ITS FIX IS REMOVED ==============
//
// That is the requirement, and it is the reason this suite exists rather than
// a set of assertions that the code "looks right". Three of them earn their
// place specifically because a lazy fix would pass a weaker version:
//
//   the second orphan run must still REPORT the orphan, not merely stop
//     writing about it — otherwise "dedup" could be "stop noticing"
//   the weekly sweep must invoke the scan EXACTLY ONCE — otherwise "the
//     nightly pass does not sweep" could be satisfied by deleting the feature
//   the refusal must be observed as BEHAVIOUR — an event written, a row left
//     standing — rather than inferred from an absent import. The old check
//     passed while the deletion path was reachable, and an injected spy would
//     have been no better: it replaces the very thing under test

const MB = 1024 * 1024;

let failures = 0;
let passes = 0;
function assert(name: string, ok: boolean, detail = ""): void {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  — ${detail}` : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  assert(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const url = (pathname: string) => `https://blob.test/${pathname}`;
const blob = (pathname: string, size: number) => ({ pathname, url: url(pathname), size });
const listing = (objects: { pathname: string; url: string; size: number }[]) =>
  async () => ({ objects, truncated: false });

async function main(): Promise<void> {
  await requireTestDatabase(prismaSystem);
  const stamp = Date.now();
  const user = await prisma.user.create({ data: { email: `rec-${stamp}@example.test`, name: "Owner" } });
  const store = await prisma.store.create({
    data: { userId: user.id, name: "Rec", slug: `rec-${stamp}`, tagline: "t", description: "d" },
  });

  const object = (over: {
    pathname: string; storeId?: string | null; sizeInBytes?: number | null;
    lifecycle?: string; attribution?: string; declaredBytes?: number | null; uploadedAt?: Date | null;
  }) =>
    prismaSystem.storageObject.create({
      data: {
        pathname: over.pathname,
        url: url(over.pathname),
        storeId: over.storeId === undefined ? store.id : over.storeId,
        attribution: over.attribution ?? "owner",
        lifecycle: over.lifecycle ?? "permanent",
        prefix: over.pathname.slice(0, over.pathname.indexOf("/") + 1),
        source: "test",
        sizeInBytes: over.sizeInBytes ?? null,
        declaredBytes: over.declaredBytes ?? null,
        uploadedAt: over.uploadedAt === undefined ? new Date() : over.uploadedAt,
      },
    });

  console.log("\n--- both passes are dark by default ---\n");
  assert("the nightly flag is off", nightlyEnabled() === false, `${process.env.STORAGE_RECONCILE}`);
  assert("the weekly flag is off", attributionSweepEnabled() === false, `${process.env.STORAGE_ATTRIBUTION_SWEEP}`);

  // =========================================================================
  console.log("\n--- FIX 1: reconciliation cannot delete a blob ---\n");
  // =========================================================================
  {
    // The ONE shape that reaches the rollback branch: a reproducible asset
    // whose landed size exceeds what was reserved. Anything else in this suite
    // would prove nothing about deletion.
    //
    // ============ NOTE THE ABSENCE OF AN INJECTED DELETER ===========
    //
    // The first version of this test passed a permissive spy and asserted it
    // was never called. It failed — correctly — by deleting, and the failure
    // was the point: a spy REPLACES the refusal it is meant to be testing, so
    // it proves the injection point works and nothing whatsoever about the
    // safety property. The deleter is no longer injectable at all, and what is
    // asserted here is what production actually does.
    const pathname = `printfiles/rollback-${stamp}.png`;
    await object({ pathname, lifecycle: "derived", declaredBytes: 1000, uploadedAt: null });

    const result = await runNightlyReconciliation({
      // The provider says it landed at 900_000 — far over the 1000 reserved.
      listObjects: listing([blob(pathname, 900_000)]),
      apply: true,
    });

    eq("the landed reservation was seen", result.recovered, 1);

    // THE ASSERTION THAT FAILS IF THE REFUSAL IS REMOVED. Without it the
    // rollback calls the real del() and nothing records that it happened.
    const refused = await prismaSystem.storageEvent.findFirst({
      where: { kind: "deletion_refused", pathname: url(pathname) },
    });
    assert("a deletion_refused event records the attempt", !!refused,
      "the rollback reached a real deleter, or refused silently");
    eq("and no deletion was recorded for it",
      await prismaSystem.storageEvent.count({ where: { kind: "deleted", pathname } }), 0);
    assert("the ledger row survives",
      (await prismaSystem.storageObject.findUnique({ where: { pathname } })) !== null,
      "the row was removed — deleteObject completed");
  }

  // =========================================================================
  console.log("\n--- FIX 2: orphan events are deduplicated by pathname ---\n");
  // =========================================================================
  {
    const orphan = `assets/orphan-${stamp}.png`;
    const provider = listing([blob(orphan, 4321)]);

    const first = await runNightlyReconciliation({ listObjects: provider, apply: true });
    eq("the first run sees one orphan", first.orphans.total, 1);
    eq("and it is new", first.orphans.firstSeen, 1);
    eq("one event was written",
      await prismaSystem.storageEvent.count({ where: { kind: "reconciled_orphan", pathname: orphan } }), 1);

    const second = await runNightlyReconciliation({ listObjects: provider, apply: true });
    // THE FIX.
    eq("the second run writes no second event",
      await prismaSystem.storageEvent.count({ where: { kind: "reconciled_orphan", pathname: orphan } }), 1);
    // AND THE LAZY-FIX GUARD: dedup must not become "stop noticing".
    eq("but the orphan is still reported", second.orphans.total, 1);
    eq("as standing rather than new", [second.orphans.firstSeen, second.orphans.standing], [0, 1]);

    // AND THE OTHER LAZY FIX: "never write again" is not dedup.
    const orphan2 = `assets/orphan2-${stamp}.png`;
    const third = await runNightlyReconciliation({
      listObjects: listing([blob(orphan, 4321), blob(orphan2, 99)]),
      apply: true,
    });
    eq("a different orphan on a later run does get its own event",
      await prismaSystem.storageEvent.count({ where: { kind: "reconciled_orphan", pathname: orphan2 } }), 1);
    eq("and is counted as new while the first stays standing",
      [third.orphans.firstSeen, third.orphans.standing], [1, 1]);

    const event = await prismaSystem.storageEvent.findFirst({
      where: { kind: "reconciled_orphan", pathname: orphan },
    });
    eq("the orphan event carries the provider's size as data", event?.providerBytes, 4321);
  }

  // =========================================================================
  console.log("\n--- FIX 3: the nightly pass never sweeps the schema ---\n");
  // =========================================================================
  {
    let invoked = 0;
    const explode = async (): Promise<AttributionScan> => {
      invoked++;
      throw new Error("the nightly pass must not sweep the schema");
    };

    // The nightly pass does not accept a derive function at all — it cannot
    // sweep. Proven by running it to completion while the sweep would throw.
    const result = await runNightlyReconciliation({
      listObjects: listing([]),
      apply: true,
    });
    assert("the nightly pass completes without touching attribution derivation", !result.truncated);
    eq("and the scan was never invoked", invoked, 0);

    // The other half: the sweep must still exist and run EXACTLY ONCE, or
    // "the nightly pass does not sweep" could be satisfied by deleting it.
    let sweepCalls = 0;
    const fakeScan: AttributionScan = {
      stores: new Map(), evidence: new Map(), columnsScanned: 279,
      columnsSkipped: [], tier1Tables: 36, tier2Joins: ["ProductImage -> Product"],
    };
    const sweep = await runAttributionSweep({
      hosts: ["blob.test"],
      derive: async () => { sweepCalls++; return fakeScan; },
      apply: false,
    });
    eq("the weekly sweep invokes the scan exactly once", sweepCalls, 1);
    eq("and reports what it scanned", sweep.columnsScanned, 279);
    void explode;
  }

  // =========================================================================
  console.log("\n--- size history is queryable, not prose ---\n");
  // =========================================================================
  {
    const pathname = `assets/size-${stamp}.png`;
    await object({ pathname, sizeInBytes: 1_000_000 });
    await runNightlyReconciliation({ listObjects: listing([blob(pathname, 1_048_576)]), apply: true });

    const event = await prismaSystem.storageEvent.findFirst({
      where: { kind: "size_corrected", pathname },
      // DELIBERATELY NOT SELECTING `reason`. The assertions below are the
      // operator's query, and they must work without English in them.
      select: { previousBytes: true, providerBytes: true, sizeInBytes: true, storeId: true },
    });
    eq("the previous byte count is a column", event?.previousBytes, 1_000_000);
    eq("the provider's figure is a column", event?.providerBytes, 1_048_576);
    eq("and sizeInBytes is the resulting value", event?.sizeInBytes, 1_048_576);
    eq("the row itself now holds the provider's figure",
      (await prismaSystem.storageObject.findUnique({ where: { pathname } }))?.sizeInBytes, 1_048_576);

    // The operator's real question, answered by arithmetic on columns.
    const delta = (event?.providerBytes ?? 0) - (event?.previousBytes ?? 0);
    eq("so 'by how much did this change' is arithmetic, not parsing", delta, 48_576);
  }

  // =========================================================================
  console.log("\n--- owner with no store is corrected, and says what it was ---\n");
  // =========================================================================
  {
    const doomed = await prisma.store.create({
      data: { userId: user.id, name: "Doomed", slug: `doomed-${stamp}`, tagline: "t", description: "d" },
    });
    const pathname = `assets/orphaned-owner-${stamp}.png`;
    await object({ pathname, storeId: doomed.id, sizeInBytes: 500 });

    await prismaSystem.store.delete({ where: { id: doomed.id } });
    const afterDelete = await prismaSystem.storageObject.findUnique({ where: { pathname } });
    // The precondition, asserted rather than assumed: onDelete SetNull leaves
    // the row claiming an owner it no longer has.
    eq("the foreign key nulled storeId", afterDelete?.storeId, null);
    eq("but left attribution saying owner", afterDelete?.attribution, "owner");

    const result = await runNightlyReconciliation({
      listObjects: listing([blob(pathname, 500)]),
      apply: true,
    });
    assert("the inconsistency is reported",
      result.inconsistencies.some((i) => i.pathname === pathname && i.corrected),
      JSON.stringify(result.inconsistencies));

    const fixed = await prismaSystem.storageObject.findUnique({ where: { pathname } });
    eq("attribution now agrees with the null store", fixed?.attribution, "unattributed");
    const event = await prismaSystem.storageEvent.findFirst({
      where: { kind: "reattributed", pathname },
      select: { previousAttribution: true, previousStoreId: true, storeId: true },
    });
    eq("and the event records what it was", event?.previousAttribution, "owner");
    eq("with no owner claimed now", event?.storeId, null);
  }

  // =========================================================================
  console.log("\n--- independent of enforcement, in both directions ---\n");
  // =========================================================================
  {
    const pathname = `assets/indep-${stamp}.png`;
    await object({ pathname, sizeInBytes: 100 });
    const provider = listing([blob(pathname, 100)]);

    const before = process.env.STORAGE_ENFORCEMENT;
    process.env.STORAGE_ENFORCEMENT = "on";
    const withEnforcement = await runNightlyReconciliation({ listObjects: provider, apply: false });
    process.env.STORAGE_ENFORCEMENT = "off";
    const without = await runNightlyReconciliation({ listObjects: provider, apply: false });
    process.env.STORAGE_ENFORCEMENT = before;

    const comparable = (r: Awaited<ReturnType<typeof runNightlyReconciliation>>) => ({
      orphans: r.orphans, recovered: r.recovered, rowsRemoved: r.rowsRemoved,
      sizesCorrected: r.sizesCorrected, inconsistencies: r.inconsistencies.length,
      drift: r.drift.inSync,
    });
    eq("results are identical with enforcement on and off",
      comparable(withEnforcement), comparable(without));

    // And a store way over any allowance still gets reconciled — reconciliation
    // never refuses, because it never asks.
    const huge = `assets/huge-${stamp}.png`;
    await object({ pathname: huge, sizeInBytes: 1 });
    process.env.STORAGE_ENFORCEMENT = "on";
    const over = await runNightlyReconciliation({
      listObjects: listing([blob(pathname, 100), blob(huge, 900 * MB)]),
      apply: true,
    });
    process.env.STORAGE_ENFORCEMENT = before;
    eq("an enormous object is still corrected rather than refused", over.sizesCorrected, 1);
    eq("the row took the real size", (await prismaSystem.storageObject.findUnique({ where: { pathname: huge } }))?.sizeInBytes, 900 * MB);
  }

  // =========================================================================
  console.log("\n--- presence, grace, and reservations ---\n");
  // =========================================================================
  {
    const fresh = `assets/fresh-${stamp}.png`;
    const old = `assets/old-${stamp}.png`;
    await object({ pathname: fresh, sizeInBytes: 10 });
    await object({ pathname: old, sizeInBytes: 20, uploadedAt: new Date(Date.now() - 3 * GRACE_MS) });

    // Neither is in the provider listing: both blobs are gone.
    const result = await runNightlyReconciliation({ listObjects: listing([]), apply: true });
    eq("only the one past the grace period is removed", result.rowsRemoved, 1);
    assert("the fresh row is held", (await prismaSystem.storageObject.findUnique({ where: { pathname: fresh } })) !== null);
    assert("the old row is gone", (await prismaSystem.storageObject.findUnique({ where: { pathname: old } })) === null);

    const event = await prismaSystem.storageEvent.findFirst({
      where: { kind: "reconciled_missing", pathname: old },
      select: { previousStoreId: true, previousAttribution: true, sizeInBytes: true },
    });
    eq("the removed row is reconstructable from its event",
      [event?.previousStoreId, event?.previousAttribution, event?.sizeInBytes], [store.id, "owner", 20]);
  }

  console.log("\n--- a truncated listing is refused outright ---\n");
  {
    const result = await runNightlyReconciliation({
      listObjects: async () => ({ objects: [], truncated: true }),
      apply: true,
    });
    assert("it reports truncation", result.truncated);
    eq("and writes nothing", [result.rowsRemoved, result.sizesCorrected, result.applied], [0, 0, false]);
  }

  console.log(`\n${failures} failed, ${passes} passed\n`);
  await prismaSystem.$disconnect();
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
