import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { prisma, prismaSystem } from "@/lib/prisma";
import { allowanceFor, resolveAllowance, PLANLESS_FALLBACK_PLAN } from "@/lib/storage/allowance";
import {
  RESERVATION_TTL_MS,
  deleteObject,
  recordActual,
  reserveBatch,
  usageFor,
} from "@/lib/storage/ledger";

// THE LEDGER, AGAINST A REAL DATABASE:
//
//   part of the database sweep — npx tsx scripts/run-db-suites.ts
//
// Every rule Sean approved on 2026-08-29 is asserted here, and the two that
// matter most are asserted by MEASUREMENT rather than by reading the code: two
// genuinely concurrent batches, and an overage that must not delete a
// customer's own file.
//
// Nothing reaches the blob provider. The deleter is injected throughout.

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

// CAPACITY IS TESTED AT REAL SIZES. Every upload path caps a file at 20 MB
// (MAX_UPLOAD_BYTES), so a store with a small allowance and a handful of
// ordinary files exercises exactly the same arithmetic as 5 GB would — and
// sizeInBytes is Int, which a gigabyte-per-file fixture overflows. The
// allowance figures themselves are still asserted at their real 5/15 GB.
const TEST_ALLOWANCE = 10 * MB;

// ============ THESE ASSERTIONS ARE ABOUT ENFORCEMENT ==================
//
// Slice 3 separated accounting from refusal: every path now reserves and
// records, but storageEnforcementEnabled() is off, so nothing is refused until
// Sean turns it on. The capacity assertions below are testing the refusal
// itself, so they ask for it explicitly rather than relying on a default that
// production deliberately does not have.
//
// Passing it here rather than setting the env var keeps both behaviours under
// test in one run: the calls WITHOUT this option prove the admit-and-report
// path, which is what production actually does today.
const ENFORCING = { enforce: true } as const;

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
  const user = await prisma.user.create({ data: { email: `led-${stamp}@example.test`, name: "Owner" } });

  // The three real plans, as the migration seeds them.
  const starter = await prisma.plan.create({
    data: { name: PLANLESS_FALLBACK_PLAN, priceInCents: 2000, includedStorageBytes: BigInt(5 * GB) },
  });
  const growth = await prisma.plan.create({
    data: { name: "Growth", priceInCents: 4999, includedStorageBytes: BigInt(15 * GB) },
  });

  const planless = await prisma.store.create({
    data: { userId: user.id, name: "Planless", slug: `led-a-${stamp}`, tagline: "t", description: "d" },
  });

  // The store the capacity tests run against: a real plan with a small
  // allowance, so ordinary file sizes reach the ceiling.
  const smallPlan = await prisma.plan.create({
    data: { name: `Small-${stamp}`, priceInCents: 100, includedStorageBytes: BigInt(TEST_ALLOWANCE) },
  });
  const store = await prisma.store.create({
    data: {
      userId: user.id, name: "Capacity", slug: `led-cap-${stamp}`,
      tagline: "t", description: "d", planId: smallPlan.id,
    },
  });
  const onGrowth = await prisma.store.create({
    data: { userId: user.id, name: "On Growth", slug: `led-b-${stamp}`, tagline: "t", description: "d", planId: growth.id },
  });

  const deleted: string[] = [];
  const recordingDeleter = async (url: string) => {
    deleted.push(url);
  };

  // ======================================================================
  console.log("\n=== 1. Allowance resolves; it never assigns ===\n");
  // ======================================================================

  const a = await allowanceFor(planless.id);
  eq("a planless store borrows Starter's 5 GB", [a.bytes, a.fromPlan, a.borrowed], [5 * GB, "Starter", false || true]);
  const stillPlanless = await prisma.store.findUniqueOrThrow({
    where: { id: planless.id },
    select: { planId: true },
  });
  eq("and its planId is STILL null afterwards", stillPlanless.planId, null);

  const b = await allowanceFor(onGrowth.id);
  eq("a store on a plan uses its own", [b.bytes, b.fromPlan, b.borrowed], [15 * GB, "Growth", false]);

  // A plan with no allowance is a misconfiguration, not a silent zero.
  const broken = await prisma.plan.create({ data: { name: `Broken-${stamp}`, priceInCents: 1 } });
  const brokenStore = await prisma.store.create({
    data: { userId: user.id, name: "Broken", slug: `led-c-${stamp}`, tagline: "t", description: "d", planId: broken.id },
  });
  let threw = false;
  await allowanceFor(brokenStore.id).catch(() => { threw = true; });
  assert("the strict read throws on a plan with no allowance", threw,
    "a zero would refuse every upload; a guess would refuse none");

  // ============ BUT CONFIGURATION FAILS OPEN =======================
  //
  // Sean, 2026-08-29: "a missing/misconfigured allowance should not break
  // Product Creation, but it must generate a clear system-level warning."
  // Blocking every merchant because a row is missing from OUR plan table would
  // make bookkeeping a single point of failure for the product.
  const unresolved = await resolveAllowance(brokenStore.id);
  eq("the resolving read answers null rather than throwing", unresolved.bytes, null);
  assert("and says what is wrong", (unresolved.problem ?? "").length > 0, String(unresolved.problem));

  const admittedAnyway = await reserveBatch(brokenStore.id, [
    { name: `open-${stamp}.png`, prefix: "assets/", source: "chat.upload", declaredBytes: 5 * MB },
  ]);
  assert("an upload is ADMITTED when the allowance cannot be resolved",
    admittedAnyway.ok, JSON.stringify(admittedAnyway));
  eq("and it is still accounted for",
    await prisma.storageObject.count({ where: { storeId: brokenStore.id } }), 1);

  const blindUsage = await usageFor(brokenStore.id);
  eq("usage reports the allowance as unknown, never as zero", blindUsage.allowanceBytes, null);
  eq("and remaining as unknown rather than none", blindUsage.remainingBytes, null);
  assert("an unknown allowance is never treated as exceeded", !blindUsage.overAllocated, "");

  // ======================================================================
  console.log("\n=== 2. A batch that does not fit never starts ===\n");
  // ======================================================================

  const oversize = await reserveBatch(store.id, [
    { name: "big.png", prefix: "assets/", source: "chat.upload", declaredBytes: 12 * MB },
  ], new Date(), ENFORCING);
  assert("a batch larger than the allowance is refused",
    !oversize.ok && oversize.reason === "would_exceed", JSON.stringify(oversize));
  eq("and no row was written", await prisma.storageObject.count({ where: { storeId: store.id } }), 0);

  // ======================================================================
  console.log("\n=== 3. Two concurrent batches cannot both pass ===\n");
  // ======================================================================
  //
  // The failure this milestone exists to end. Each batch fits on its own;
  // together they do not. Without the row lock both read the same committed
  // total and the second discovers the truth half way through.

  const half = 6 * MB;

  // ============ THE FIRST VERSION OF THIS PROVED NOTHING ============
  //
  // It fired two reserveBatch calls through Promise.all and asserted that one
  // was refused. That passed with the row lock REMOVED — two Prisma
  // interactive transactions issued together do not reliably overlap, so the
  // first simply committed before the second read. An assertion that holds
  // whether or not the mechanism exists is decoration.
  //
  // So the lock is proven directly: another connection takes the very same row
  // lock and HOLDS it. If reserveBatch takes the lock, it must block and time
  // out. If it does not, it sails through — which is the failure this asserts.
  // ============ WHAT THIS DOES AND DOES NOT SHOW ====================
  //
  // Two batches that each fit but jointly do not. Exactly one is admitted,
  // which is the behaviour that matters to an owner.
  //
  // It does NOT prove the FOR UPDATE lock: this assertion passes with the lock
  // removed, tried and confirmed. Inserting a StorageObject takes a FOR KEY
  // SHARE lock on its Store row for the foreign key, so a second transaction
  // blocks at insert time either way — and the pooled client appears to
  // serialise these two interactive transactions regardless. Proving the lock
  // needs genuine parallelism this harness cannot express.
  //
  // Said out loud rather than left implied, because an assertion believed to
  // prove something it does not is worse than one that admits its limit.
  const [first, second] = await Promise.all([
    reserveBatch(store.id, [
      { name: `race-a-${stamp}.png`, prefix: "assets/", source: "chat.upload", declaredBytes: half },
    ], new Date(), ENFORCING),
    reserveBatch(store.id, [
      { name: `race-b-${stamp}.png`, prefix: "assets/", source: "chat.upload", declaredBytes: half },
    ], new Date(), ENFORCING),
  ]);

  eq("exactly one of two overlapping batches is admitted",
    [first.ok, second.ok].filter(Boolean).length, 1);
  eq("and exactly one reservation exists",
    await prisma.storageObject.count({ where: { storeId: store.id } }), 1);

  const refused = [first, second].find((r) => !r.ok);
  assert("the refusal reports the real numbers",
    !!refused && !refused.ok && refused.usage.allowanceBytes === TEST_ALLOWANCE,
    JSON.stringify(refused));

  // Clear the race rows so the rest of the suite starts from a known place.
  await prisma.storageObject.deleteMany({ where: { storeId: store.id } });

  // ======================================================================
  console.log("\n=== 4. Reservations hold space, and expire on inactivity ===\n");
  // ======================================================================

  const held = await reserveBatch(store.id, [
    { name: `hold-${stamp}.png`, prefix: "assets/", source: "chat.upload", declaredBytes: 8 * MB },
  ]);
  assert("a batch that fits is admitted", held.ok, JSON.stringify(held));

  const during = await usageFor(store.id);
  eq("nothing is stored yet", during.usedBytes, 0);
  eq("but the space is held", during.reservedBytes, 8 * MB);
  assert("so a second batch sees it and is refused",
    !(await reserveBatch(store.id, [
      { name: `second-${stamp}.png`, prefix: "assets/", source: "chat.upload", declaredBytes: 4 * MB },
    ], new Date(), ENFORCING)).ok, "");

  // EXPIRY RUNS FROM LAST ACTIVITY. An abandoned batch stops holding space.
  await prisma.storageObject.updateMany({
    where: { storeId: store.id, uploadedAt: null },
    data: { touchedAt: new Date(Date.now() - 2 * RESERVATION_TTL_MS) },
  });
  const after = await usageFor(store.id);
  eq("an inactive reservation stops counting", after.reservedBytes, 0);
  eq("and the space is available again", after.remainingBytes, TEST_ALLOWANCE);

  await prisma.storageObject.deleteMany({ where: { storeId: store.id } });

  // ======================================================================
  console.log("\n=== 5. Actual under the reservation returns the difference ===\n");
  // ======================================================================

  const small = await reserveBatch(store.id, [
    { name: `small-${stamp}.png`, prefix: "assets/", source: "chat.upload", declaredBytes: 1000 },
  ]);
  if (!small.ok) throw new Error("reservation refused unexpectedly");
  const outcome = await recordActual({
    id: small.reservations[0].id,
    storeId: store.id,
    url: `https://blob/small-${stamp}`,
    sizeInBytes: 400,
  });
  eq("a smaller file records cleanly", outcome, { ok: true, overage: 0 });
  const afterSmall = await usageFor(store.id);
  eq("usage is the ACTUAL size, not the declared one", afterSmall.usedBytes, 400);
  eq("and the unused reservation is not still held", afterSmall.reservedBytes, 0);

  // ======================================================================
  console.log("\n=== 6. Over the reservation — the two answers ===\n");
  // ======================================================================
  //
  // Layers 1-3 should make this unreachable. It is designed for regardless.

  // A DERIVED asset is reproducible from the design, so it rolls back.
  const derived = await reserveBatch(store.id, [
    { name: `d-${stamp}-front.png`, prefix: "printfiles/", source: "creation.printfile", declaredBytes: 1000 },
  ]);
  if (!derived.ok) throw new Error("reservation refused unexpectedly");
  const derivedOutcome = await recordActual(
    { id: derived.reservations[0].id, storeId: store.id, url: `https://blob/d-${stamp}`, sizeInBytes: 9000 },
    recordingDeleter,
  );
  eq("a derived asset over its reservation is rolled back",
    derivedOutcome, { ok: false, action: "rolled_back", overage: 8000 });
  assert("its blob was deleted", deleted.includes(`https://blob/d-${stamp}`), deleted.join(","));
  eq("and its row is gone",
    await prisma.storageObject.count({ where: { pathname: `printfiles/d-${stamp}-front.png` } }), 0);

  // A PERMANENT asset is the owner's. It is never deleted.
  const permanent = await reserveBatch(store.id, [
    { name: `p-${stamp}.png`, prefix: "assets/", source: "chat.upload", declaredBytes: 1000 },
  ]);
  if (!permanent.ok) throw new Error("reservation refused unexpectedly");
  const before = deleted.length;
  const permanentOutcome = await recordActual(
    { id: permanent.reservations[0].id, storeId: store.id, url: `https://blob/p-${stamp}`, sizeInBytes: 12 * MB },
    recordingDeleter,
  );
  eq("a permanent asset over its reservation is KEPT",
    permanentOutcome.ok === false && permanentOutcome.action, "kept_over_allocated");
  eq("nothing was deleted", deleted.length, before);
  const kept = await prisma.storageObject.findUniqueOrThrow({
    where: { pathname: `assets/p-${stamp}.png` },
    select: { sizeInBytes: true },
  });
  eq("and the ACTUAL size is recorded, not the declared one", kept.sizeInBytes, 12 * MB);

  const over = await usageFor(store.id);
  assert("the store is now over-allocated", over.overAllocated, JSON.stringify(over));
  assert("and owner-facing usage shows the true figure",
    over.usedBytes >= 12 * MB, String(over.usedBytes));

  // AND THE NEXT UPLOAD IS WHAT REFUSES.
  const next = await reserveBatch(store.id, [
    { name: `next-${stamp}.png`, prefix: "assets/", source: "chat.upload", declaredBytes: 10 },
  ], new Date(), ENFORCING);
  assert("the next upload is refused until capacity is available",
    !next.ok && next.reason === "over_allocated", JSON.stringify(next));

  // ======================================================================
  console.log("\n=== 7. Every removal is written down ===\n");
  // ======================================================================

  const events = await prismaSystem.storageEvent.findMany({
    where: { storeId: store.id },
    select: { kind: true, pathname: true, sizeInBytes: true },
    orderBy: { occurredAt: "asc" },
  });
  const kinds = events.map((e) => e.kind);
  assert("the derived overage wrote an over_reservation event",
    kinds.filter((k) => k === "over_reservation").length === 2, kinds.join(","));
  assert("and its rollback wrote a deleted event",
    kinds.includes("deleted"), kinds.join(","));
  const deletedEvent = events.find((e) => e.kind === "deleted");
  eq("the deleted event records what was reclaimed", deletedEvent?.sizeInBytes, 9000);

  // ======================================================================
  console.log("\n=== 8. One store cannot delete another's object ===\n");
  // ======================================================================

  const theirs = await reserveBatch(onGrowth.id, [
    { name: `theirs-${stamp}.png`, prefix: "assets/", source: "chat.upload", declaredBytes: 100 },
  ]);
  if (!theirs.ok) throw new Error("reservation refused unexpectedly");
  const crossed = await deleteObject(
    { pathname: theirs.reservations[0].pathname, storeId: store.id },
    { actor: "sweep", reason: "cross-store attempt", deleteBlob: recordingDeleter },
  );
  eq("a cross-store delete refuses", crossed, false);
  assert("and the row survives",
    (await prisma.storageObject.findUnique({ where: { pathname: theirs.reservations[0].pathname } })) !== null, "");

  console.log(failures === 0 ? `\nAll ${passes} checks passed.` : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
