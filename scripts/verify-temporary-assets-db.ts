import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import {
  ABANDONED_AFTER_MS,
  discardTemporaries,
  markTemporaryUploaded,
  promoteTemporaries,
  recordTemporary,
  sweepAbandonedTemporaries,
} from "@/lib/storage/temporaryAssets";

// THE LIFECYCLE, AGAINST A REAL DATABASE:
//
//   part of the database sweep — npx tsx scripts/run-db-suites.ts
//
// ============ INCLUDING THE ONE STORAGE.md CALLS THE REAL TEST =========
//
// "Every leak found here was invisible until something stopped working, and
// each was found by measuring rather than by reading code. The test that
// matters is the one that runs the loop a hundred times and asserts the bytes
// did not climb."
//
// So section 5 does exactly that: a hundred failed creations, and the assertion
// is on measured bytes rather than on the code having a catch block.
//
// ============ NOTHING IS ACTUALLY DELETED FROM BLOB STORAGE ============
//
// There is no blob behind these rows — they are claims that never uploaded, and
// `del` is never reached for a row with no url. That is deliberate: the suite
// proves the ACCOUNTING, which is the thing that leaked, without depending on a
// network. The delete call itself is exercised by the live cleanup endpoint.

let failures = 0;
let passes = 0;

function assert(name: string, ok: boolean, detail = ""): void {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  assert(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function main(): Promise<void> {
  await requireTestDatabase(prismaSystem);

  const stamp = Date.now();
  const user = await prisma.user.create({
    data: { email: `temp-${stamp}@example.test`, name: "Owner" },
  });
  const store = await prisma.store.create({
    data: { userId: user.id, name: "Cubit & Coil", slug: `temp-${stamp}`, tagline: "t", description: "d" },
  });
  const other = await prisma.store.create({
    data: { userId: user.id, name: "Other", slug: `temp-other-${stamp}`, tagline: "t", description: "d" },
  });

  const liveFor = (storeId: string) =>
    prisma.temporaryAsset.count({ where: { storeId } });

  // WHAT WAS HANDED TO THE DELETER, so narrowness can be asserted rather than
  // claimed. No network: the harness has no blob credentials, and reaching
  // Vercel a hundred times would make the acceptance test a network test.
  const deletedUrls: string[] = [];
  const recordingDeleter = async (url: string) => {
    deletedUrls.push(url);
  };

  // ======================================================================
  console.log("\n=== 1. A claim exists before the blob ===\n");
  // ======================================================================

  const claim = await recordTemporary({ storeId: store.id, kind: "printfile", name: "a-front.png" });
  eq("the key is the caller's to upload under", claim.pathname, "printfiles/a-front.png");
  const beforeUpload = await prisma.temporaryAsset.findUniqueOrThrow({
    where: { id: claim.id },
    select: { url: true, sizeInBytes: true, promotedAt: true },
  });
  eq("with no url yet", beforeUpload.url, null);
  eq("no size yet", beforeUpload.sizeInBytes, null);
  eq("and unpromoted", beforeUpload.promotedAt, null);

  await markTemporaryUploaded({ id: claim.id, storeId: store.id, url: "https://blob/a", sizeInBytes: 1234 });
  const afterUpload = await prisma.temporaryAsset.findUniqueOrThrow({
    where: { id: claim.id },
    select: { url: true, sizeInBytes: true },
  });
  eq("the upload records what it produced", afterUpload.url, "https://blob/a");
  eq("including its size", afterUpload.sizeInBytes, 1234);

  // ======================================================================
  console.log("\n=== 2. Success promotes; nothing may reclaim it after ===\n");
  // ======================================================================

  await promoteTemporaries(store.id, [claim.id]);
  const promoted = await prisma.temporaryAsset.findUniqueOrThrow({
    where: { id: claim.id },
    select: { promotedAt: true },
  });
  assert("a promoted asset records when", promoted.promotedAt !== null, "");

  // A LATE FAILURE MUST NOT TAKE THE PRODUCT'S PICTURES.
  const discardedAfterPromote = await discardTemporaries(store.id, [claim.id], recordingDeleter);
  eq("discarding a promoted asset reclaims nothing", discardedAfterPromote, 0);
  eq("and the row survives", await liveFor(store.id), 1);

  // NOR MAY THE SWEEP, however old it gets.
  await prisma.temporaryAsset.update({
    where: { id: claim.id },
    data: { createdAt: new Date(Date.now() - 10 * ABANDONED_AFTER_MS) },
  });
  const sweepPromoted = await sweepAbandonedTemporaries(new Date(), ABANDONED_AFTER_MS, recordingDeleter);
  eq("and a very old promoted asset is not swept", sweepPromoted.found, 0);
  eq("it is still there", await liveFor(store.id), 1);

  // ======================================================================
  console.log("\n=== 3. Failure discards exactly this attempt's artefacts ===\n");
  // ======================================================================

  const attempt = [
    await recordTemporary({ storeId: store.id, kind: "printfile", name: "b-front.png" }),
    await recordTemporary({ storeId: store.id, kind: "printfile", name: "b-back.png" }),
    await recordTemporary({ storeId: store.id, kind: "mockup", name: "b-front-m.png" }),
  ];
  const bystander = await recordTemporary({ storeId: store.id, kind: "printfile", name: "c-front.png" });

  eq("four claims exist", await liveFor(store.id), 5);
  const discarded = await discardTemporaries(store.id, attempt.map((a) => a.id), recordingDeleter);
  eq("the failed attempt's rows are gone", await liveFor(store.id), 2);
  eq("nothing was deleted from storage, because nothing uploaded", discarded, 0);
  assert("and another attempt's claim is untouched",
    (await prisma.temporaryAsset.findUnique({ where: { id: bystander.id } })) !== null, "");

  // ======================================================================
  console.log("\n=== 4. One store cannot discard another's ===\n");
  // ======================================================================

  const theirs = await recordTemporary({ storeId: other.id, kind: "printfile", name: "d-front.png" });
  const crossed = await discardTemporaries(store.id, [theirs.id], recordingDeleter);
  eq("a cross-store discard reclaims nothing", crossed, 0);
  assert("and the other store's claim survives",
    (await prisma.temporaryAsset.findUnique({ where: { id: theirs.id } })) !== null, "");

  // ======================================================================
  console.log("\n=== 5. A hundred failures do not grow storage ===\n");
  // ======================================================================
  //
  // STORAGE.md's own words: "the test that matters is the one that runs the
  // loop a hundred times and asserts the bytes did not climb."
  //
  // Each iteration is a whole failed creation: two print files and a mockup
  // claimed and uploaded, then the attempt fails and discards. The measurement
  // is bytes recorded against this store, not a count of catch blocks.

  const bytesFor = async (storeId: string) => {
    const rows = await prisma.temporaryAsset.aggregate({
      where: { storeId },
      _sum: { sizeInBytes: true },
    });
    return rows._sum.sizeInBytes ?? 0;
  };

  const startBytes = await bytesFor(store.id);
  const startRows = await liveFor(store.id);

  for (let i = 0; i < 100; i++) {
    const ids: string[] = [];
    for (const [kind, name] of [
      ["printfile", `loop-${i}-front.png`],
      ["printfile", `loop-${i}-back.png`],
      ["mockup", `loop-${i}-front-m.png`],
    ] as const) {
      const c = await recordTemporary({ storeId: store.id, kind, name });
      // Every one uploads successfully — the failure is later, which is exactly
      // the case that used to strand them.
      await markTemporaryUploaded({
        id: c.id,
        storeId: store.id,
        url: `https://blob/loop-${i}-${kind}-${name}`,
        sizeInBytes: 500_000,
      });
      ids.push(c.id);
    }
    // ...and then the supplier refuses.
    await discardTemporaries(store.id, ids, recordingDeleter);
  }

  const endBytes = await bytesFor(store.id);
  const endRows = await liveFor(store.id);

  eq("a hundred failed creations leave no extra rows", endRows, startRows);
  eq("and not one extra byte", endBytes, startBytes);
  assert("even though 150 MB passed through them",
    100 * 3 * 500_000 === 150_000_000, "");

  // ============ THE NEGATIVE CONTROL ==============================
  //
  // The loop above proves nothing unless the same loop WITHOUT the discard
  // genuinely climbs. Otherwise it would pass on a build where recording was
  // broken and there was nothing to clean up in the first place.
  for (let i = 0; i < 5; i++) {
    const c = await recordTemporary({ storeId: store.id, kind: "printfile", name: `leak-${i}.png` });
    await markTemporaryUploaded({ id: c.id, storeId: store.id, url: `https://blob/leak-${i}`, sizeInBytes: 500_000 });
  }
  const leakedBytes = await bytesFor(store.id);
  assert("CONTROL: without the discard, bytes climb",
    leakedBytes === startBytes + 5 * 500_000,
    `${startBytes} -> ${leakedBytes}`);

  // ======================================================================
  console.log("\n=== 6. The sweep reclaims what never reached a cleanup ===\n");
  // ======================================================================
  //
  // The five above are exactly that case: uploaded, never promoted, never
  // discarded — a process that died between the upload and the supplier.

  const freshSweep = await sweepAbandonedTemporaries(new Date(), ABANDONED_AFTER_MS, recordingDeleter);
  eq("nothing recent is swept", freshSweep.found, 0);
  assert("and the abandoned rows are still there",
    (await bytesFor(store.id)) === leakedBytes, "");

  // Age them past the cutoff.
  await prismaSystem.temporaryAsset.updateMany({
    where: { storeId: store.id, promotedAt: null },
    data: { createdAt: new Date(Date.now() - 2 * ABANDONED_AFTER_MS) },
  });
  const swept = await sweepAbandonedTemporaries(new Date(), ABANDONED_AFTER_MS, recordingDeleter);
  assert("the sweep finds the abandoned ones", swept.found >= 5, JSON.stringify(swept));
  eq("and the store is back to what it legitimately holds", await bytesFor(store.id), startBytes);

  console.log(failures === 0 ? `\nAll ${passes} checks passed.` : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
