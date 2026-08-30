import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";

import {
  recordActual,
  recordActualByPathname,
  recordUnattributed,
  releaseReservation,
  reserveClientUpload,
  reserveOne,
  splitPathname,
  storageEnforcementEnabled,
  usageFor,
} from "@/lib/storage/ledger";
import { recordTemporary, markTemporaryUploaded, sweepAbandonedTemporaries } from "@/lib/storage/temporaryAssets";

// THE WRITE PATHS, AGAINST A REAL DATABASE:
//
//   part of the database sweep — npx tsx scripts/run-db-suites.ts write-paths-db
//
// scripts/verify-write-paths.ts proves no path CAN bypass the ledger, by
// reading the source. This proves the paths that exist BEHAVE, by running them.
// The two answer different questions and neither substitutes for the other.
//
// Nothing reaches the blob provider: the deleter is injected everywhere, and
// every "upload" here is a function call with a known byte count.

const MB = 1024 * 1024;
const TEST_ALLOWANCE = 10 * MB;

let failures = 0;
let passes = 0;
function assert(name: string, ok: boolean, detail = ""): void {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  — ${detail}` : ""}`);
}

async function main(): Promise<void> {
  await requireTestDatabase(prismaSystem);
  const stamp = Date.now();

  const user = await prisma.user.create({ data: { email: `wp-${stamp}@example.test`, name: "Owner" } });
  // A UNIQUELY NAMED PLAN. Plan.name is unique, and verify-storage-ledger-db
  // creates the real "Starter" row in the same database — so borrowing that
  // name made this suite pass alone and fail whenever it ran after that one.
  // Nothing here depends on the fallback plan's name: the store below names its
  // plan by id.
  const plan = await prisma.plan.create({
    data: { name: `WP Plan ${stamp}`, priceInCents: 2000, includedStorageBytes: BigInt(TEST_ALLOWANCE) },
  });
  const store = await prisma.store.create({
    data: {
      userId: user.id, name: `WP ${stamp}`, slug: `wp-${stamp}`,
      tagline: "t", description: "d", planId: plan.id,
    },
  });

  console.log("\n--- enforcement is wired but dark ---\n");
  assert(
    "quota enforcement is off by default",
    storageEnforcementEnabled() === false,
    `STORAGE_ENFORCEMENT=${process.env.STORAGE_ENFORCEMENT ?? "(unset)"}`,
  );
  {
    // A batch far larger than the allowance. With enforcement off it is
    // ADMITTED — accounting without refusal, which is exactly the state Sean
    // asked for — and with enforcement on the same call refuses.
    const huge = { name: `huge-${stamp}.png`, prefix: "assets/", source: "test", declaredBytes: TEST_ALLOWANCE * 2 };
    const admitted = await reserveOne(store.id, huge);
    assert("a batch over the allowance is admitted while enforcement is off", admitted.ok);
    if (admitted.ok) await releaseReservation(admitted.reservations[0].id, store.id);

    const refused = await reserveOne(store.id, { ...huge, name: `huge2-${stamp}.png` }, new Date(), { enforce: true });
    assert(
      "the same batch refuses when enforcement is on",
      !refused.ok && refused.reason === "would_exceed",
      JSON.stringify(refused),
    );
  }

  console.log("\n--- the actual byte count replaces the reservation ---\n");
  {
    const declared = 4 * MB;
    const actual = 1_234_567; // smaller, as a compressed upload usually is
    const reservation = await reserveOne(store.id, {
      name: `replace-${stamp}.png`, prefix: "assets/", source: "test", declaredBytes: declared,
    });
    if (!reservation.ok) throw new Error("fixture reservation refused");
    const row = reservation.reservations[0];

    const held = await usageFor(store.id);
    assert("before the upload, the reservation holds the DECLARED size", held.reservedBytes === declared, `${held.reservedBytes}`);
    assert("and nothing is counted as stored yet", held.usedBytes === 0, `${held.usedBytes}`);

    const outcome = await recordActual({
      id: row.id, storeId: store.id, url: `https://blob.test/${row.pathname}`, sizeInBytes: actual,
    });
    assert("recording the upload succeeds", outcome.ok && outcome.overage === 0, JSON.stringify(outcome));

    const after = await usageFor(store.id);
    assert("afterwards the reservation holds nothing", after.reservedBytes === 0, `${after.reservedBytes}`);
    assert("and usage is the ACTUAL size, not the declared one", after.usedBytes === actual, `${after.usedBytes}`);
    assert("the declared figure is not added to the actual", after.committedBytes === actual, `${after.committedBytes}`);

    const stored = await prismaSystem.storageObject.findUnique({ where: { pathname: row.pathname } });
    assert("the row keeps both numbers, so an overage is still auditable",
      stored?.declaredBytes === declared && stored?.sizeInBytes === actual,
      `declared ${stored?.declaredBytes}, actual ${stored?.sizeInBytes}`);
  }

  console.log("\n--- failed derived creation rolls back ---\n");
  {
    const deleted: string[] = [];
    const reservation = await reserveOne(store.id, {
      name: `derived-${stamp}.png`, prefix: "printfiles/", source: "test", declaredBytes: 100_000,
    });
    if (!reservation.ok) throw new Error("fixture reservation refused");
    const row = reservation.reservations[0];
    assert("a printfile is classed derived", (await prismaSystem.storageObject.findUnique({
      where: { id: row.id }, select: { lifecycle: true },
    }))?.lifecycle === "derived");

    // It lands larger than authorised — the case layers 1-3 should make
    // unreachable, which is precisely why this layer is tested.
    const outcome = await recordActual(
      { id: row.id, storeId: store.id, url: `https://blob.test/${row.pathname}`, sizeInBytes: 900_000 },
      async (url) => { deleted.push(url); },
    );
    assert("an oversized derived asset is rolled back",
      !outcome.ok && outcome.action === "rolled_back", JSON.stringify(outcome));
    assert("its blob is deleted", deleted.length === 1, JSON.stringify(deleted));
    assert("its row is gone", (await prismaSystem.storageObject.findUnique({ where: { id: row.id } })) === null);
    const event = await prismaSystem.storageEvent.findFirst({
      where: { pathname: row.pathname, kind: "over_reservation" },
    });
    assert("and the overage is recorded rather than silently swallowed", !!event, "no over_reservation event");
  }

  console.log("\n--- an oversized PERMANENT asset is never deleted ---\n");
  {
    const deleted: string[] = [];
    const reservation = await reserveOne(store.id, {
      name: `permanent-${stamp}.png`, prefix: "assets/", source: "test", declaredBytes: 100_000,
    });
    if (!reservation.ok) throw new Error("fixture reservation refused");
    const row = reservation.reservations[0];

    const outcome = await recordActual(
      { id: row.id, storeId: store.id, url: `https://blob.test/${row.pathname}`, sizeInBytes: 900_000 },
      async (url) => { deleted.push(url); },
    );
    assert("it is kept, not rolled back",
      !outcome.ok && outcome.action === "kept_over_allocated", JSON.stringify(outcome));
    assert("nothing was deleted", deleted.length === 0, JSON.stringify(deleted));
    const stored = await prismaSystem.storageObject.findUnique({ where: { id: row.id } });
    assert("the row survives with the REAL size, never the flattering one",
      stored?.sizeInBytes === 900_000, `${stored?.sizeInBytes}`);
  }

  console.log("\n--- permanent assets cannot be reached by temporary cleanup ---\n");
  {
    const deleted: string[] = [];
    // A permanent asset, recorded exactly as a real upload records one.
    const permanent = await reserveOne(store.id, {
      name: `keepme-${stamp}.png`, prefix: "assets/", source: "test", declaredBytes: 1000,
    });
    if (!permanent.ok) throw new Error("fixture reservation refused");
    await recordActual({
      id: permanent.reservations[0].id, storeId: store.id,
      url: `https://blob.test/${permanent.reservations[0].pathname}`, sizeInBytes: 1000,
    });

    // A TemporaryAsset row that LIES about its pathname, claiming a permanent
    // key. The prefix guard is the thing being tested, so the test has to be
    // able to reach it — this is the only way a permanent object could ever be
    // offered to the sweep.
    const liar = await prismaSystem.temporaryAsset.create({
      data: {
        storeId: store.id,
        pathname: permanent.reservations[0].pathname,
        url: `https://blob.test/${permanent.reservations[0].pathname}`,
        kind: "printfile",
        createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
      },
    });

    // A genuine abandoned temporary, so the sweep is proven to still work.
    const real = await recordTemporary({ storeId: store.id, kind: "printfile", name: `real-${stamp}.png` });
    await markTemporaryUploaded({ id: real.id, storeId: store.id, url: `https://blob.test/${real.pathname}`, sizeInBytes: 50 });
    await prismaSystem.temporaryAsset.update({
      where: { id: real.id }, data: { createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000) },
    });

    const result = await sweepAbandonedTemporaries(new Date(), 60 * 60 * 1000, async (url) => { deleted.push(url); });
    assert("the sweep found both rows", result.found === 2, `${result.found}`);
    assert("but deleted only the genuinely temporary one", result.deleted === 1, `${result.deleted}`);
    assert("the permanent asset's blob was never deleted",
      !deleted.some((u) => u.includes("keepme")), JSON.stringify(deleted));
    assert("and its ledger row is untouched",
      (await prismaSystem.storageObject.findUnique({ where: { pathname: permanent.reservations[0].pathname } })) !== null);
    assert("the lying row is left in place rather than acted on",
      (await prismaSystem.temporaryAsset.findUnique({ where: { id: liar.id } })) !== null);
  }

  console.log("\n--- a failed permanent upload stays accounted for ---\n");
  {
    const reservation = await reserveOne(store.id, {
      name: `failed-${stamp}.png`, prefix: "assets/", source: "test", declaredBytes: 500_000,
    });
    if (!reservation.ok) throw new Error("fixture reservation refused");
    const row = reservation.reservations[0];
    const before = await usageFor(store.id);
    assert("the reservation holds space while the upload is in flight",
      before.reservedBytes === 500_000, `${before.reservedBytes}`);

    // The upload throws. No bytes exist, so the space must come back.
    const released = await releaseReservation(row.id, store.id);
    assert("the reservation is released", released);
    const after = await usageFor(store.id);
    assert("no phantom bytes are left held", after.reservedBytes === 0, `${after.reservedBytes}`);
    assert("and nothing was added to what is stored", after.usedBytes === before.usedBytes, `${after.usedBytes}`);
    assert("the row is gone, not left as a half-fact",
      (await prismaSystem.storageObject.findUnique({ where: { id: row.id } })) === null);
  }

  console.log("\n--- releasing can only ever remove a promise, never a fact ---\n");
  {
    const reservation = await reserveOne(store.id, {
      name: `landed-${stamp}.png`, prefix: "assets/", source: "test", declaredBytes: 2000,
    });
    if (!reservation.ok) throw new Error("fixture reservation refused");
    const row = reservation.reservations[0];
    await recordActual({ id: row.id, storeId: store.id, url: `https://blob.test/${row.pathname}`, sizeInBytes: 2000 });

    const released = await releaseReservation(row.id, store.id);
    assert("a landed upload cannot be released", released === false);
    assert("its row survives", (await prismaSystem.storageObject.findUnique({ where: { id: row.id } })) !== null);
  }

  console.log("\n--- the client-upload path: reserve at the door, record on completion ---\n");
  {
    const pathname = `assets/client-${stamp}.png`;
    const reservation = await reserveClientUpload(store.id, {
      pathname, source: "asset.clientUpload", ceilingBytes: 20 * MB,
    });
    assert("the reservation takes the key the browser asked for",
      reservation.pathname === pathname, reservation.pathname);
    assert("and grants a ceiling for the provider to enforce",
      reservation.ceilingBytes === 20 * MB, `${reservation.ceilingBytes}`);
    const { prefix } = splitPathname(pathname);
    assert("the key still splits back to its declared prefix", prefix === "assets/", prefix);

    const held = await usageFor(store.id);
    const beforeUsed = held.usedBytes;
    assert("the ceiling is held as a reservation", held.reservedBytes === 20 * MB, `${held.reservedBytes}`);

    // A retry of the same upload must not create a second row.
    const retry = await reserveClientUpload(store.id, {
      pathname, source: "asset.clientUpload", ceilingBytes: 20 * MB,
    });
    assert("a retry reuses the reservation rather than duplicating it", retry.id === reservation.id);
    assert("so one blob still has exactly one row",
      (await prismaSystem.storageObject.count({ where: { pathname } })) === 1);

    // The completion webhook, with the provider's real figure.
    const real = 812_345;
    await recordActualByPathname({ pathname, url: `https://blob.test/${pathname}`, sizeInBytes: real });
    const after = await usageFor(store.id);
    assert("the ceiling is released once the real size is known",
      after.reservedBytes === 0, `${after.reservedBytes}`);
    assert("and only the actual bytes are counted",
      after.usedBytes === beforeUsed + real, `${after.usedBytes} vs ${beforeUsed + real}`);
  }

  console.log("\n--- the pre-store path is recorded, never attributed ---\n");
  {
    const pathname = `products/prestore-${stamp}.png`;
    await recordUnattributed({
      pathname, url: `https://blob.test/${pathname}`, sizeInBytes: 4321,
      source: "image.generated.prestore", contentType: "image/png",
    });
    const row = await prismaSystem.storageObject.findUnique({ where: { pathname } });
    assert("a blob with no business still gets a row", !!row);
    assert("with no store attached", row?.storeId === null, `${row?.storeId}`);
    assert("and honestly labelled unattributed", row?.attribution === "unattributed", row?.attribution);
    assert("its lifecycle comes from the declared prefix", row?.lifecycle === "permanent", row?.lifecycle);
    assert("declaredBytes stays null — there was no reservation", row?.declaredBytes === null);
    assert("the real size is recorded", row?.sizeInBytes === 4321, `${row?.sizeInBytes}`);

    // The whole point: it cannot be charged to anybody.
    const usage = await usageFor(store.id);
    const counted = await prismaSystem.storageObject.count({ where: { storeId: store.id, pathname } });
    assert("it is counted against no store", counted === 0);
    void usage;
  }

  console.log(`\n${failures} failed, ${passes} passed\n`);
  await prismaSystem.$disconnect();
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
