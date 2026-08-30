import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { ownedObjects, storageForOwner } from "@/lib/storage/ledger";
import { buildLedgerStorageReport } from "@/lib/storage/ledgerReport";

// AN OWNER SEES THEIR OWN FILES AND NOBODY ELSE'S:
//
//   part of the database sweep — npx tsx scripts/run-db-suites.ts owner-storage-db
//
// ============ THE THREE THINGS THAT NEED REAL ROWS (2026-08-30) ========
//
// The presentation is pure and proven separately. What cannot be proven there
// is what the QUERY reaches, and all three failures would be silent:
//
//   another business's bytes appearing in this owner's total
//   the 36 unattributed objects being attributed to somebody
//   a live reservation counted as a file that exists
//
// The first is a tenant leak. The second invents ownership. The third shows a
// number that SHRINKS when an upload succeeds. None of them would throw.

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

async function main(): Promise<void> {
  await requireTestDatabase(prismaSystem);
  const stamp = Date.now();
  const user = await prisma.user.create({ data: { email: `os-${stamp}@example.test`, name: "Owner" } });

  const mine = await prisma.store.create({
    data: { userId: user.id, name: "Mine", slug: `os-a-${stamp}`, tagline: "t", description: "d" },
  });
  const theirs = await prisma.store.create({
    data: { userId: user.id, name: "Theirs", slug: `os-b-${stamp}`, tagline: "t", description: "d" },
  });
  const emptyStore = await prisma.store.create({
    data: { userId: user.id, name: "Empty", slug: `os-c-${stamp}`, tagline: "t", description: "d" },
  });

  const object = (
    pathname: string,
    storeId: string | null,
    sizeInBytes: number | null,
    lifecycle: string,
    landed = true,
  ) =>
    prismaSystem.storageObject.create({
      data: {
        pathname, url: `https://blob.test/${pathname}`, storeId,
        attribution: storeId ? "owner" : "unattributed",
        lifecycle, prefix: pathname.slice(0, pathname.indexOf("/") + 1), source: "test",
        sizeInBytes: landed ? sizeInBytes : null,
        declaredBytes: landed ? null : 999_999,
        uploadedAt: landed ? new Date() : null,
      },
    });

  await object(`assets/mine-1-${stamp}.png`, mine.id, 1000, "permanent");
  await object(`products/mine-2-${stamp}.png`, mine.id, 2500, "permanent");
  await object(`printfiles/mine-3-${stamp}.png`, mine.id, 500, "derived");
  await object(`assets/theirs-1-${stamp}.png`, theirs.id, 8_000_000, "permanent");
  await object(`assets/nobody-1-${stamp}.png`, null, 90, "permanent");
  await object(`products/nobody-2-${stamp}.png`, null, 10, "permanent");
  // In flight: reserved, never landed.
  await object(`assets/mine-held-${stamp}.png`, mine.id, null, "permanent", false);

  console.log("\n--- one business sees only its own ---\n");
  const ours = await storageForOwner(mine.id);
  eq("the file count is this business's landed objects", ours.fileCount, 3);
  eq("and the bytes are only theirs", ours.totalBytes, 4000);
  assert("the other business's 8 MB is nowhere in it", ours.totalBytes < 8_000_000, `${ours.totalBytes}`);

  const others = await storageForOwner(theirs.id);
  eq("and the other business sees only its own", [others.fileCount, others.totalBytes], [1, 8_000_000]);

  console.log("\n--- the unattributed reach nobody ---\n");
  eq("this suite's own owner views hold only its own bytes",
    (await Promise.all([mine.id, theirs.id, emptyStore.id].map((id) => storageForOwner(id))))
      .reduce((s, v) => s + v.totalBytes, 0),
    4000 + 8_000_000);

  // ============ ACROSS EVERY STORE IN THE DATABASE ==================
  //
  // Not by subtracting from a platform total. The first version of this did
  // exactly that — owner views summed, platform total minus that, asserted
  // equal to the unattributed — and it passed alone and failed in a batch,
  // because another suite's rows land in the platform total and not in this
  // suite's three stores. That is a test coupled to what every other suite
  // happens to create, which is a test that will fail for reasons that have
  // nothing to do with the code under test.
  //
  // The claim is simply: every owner view together accounts for exactly the
  // rows that HAVE an owner. Whatever else is in the database, an unattributed
  // row is in none of them.
  const allStores = await prismaSystem.store.findMany({ select: { id: true } });
  const everyOwnerTotal = (
    await Promise.all(allStores.map((s) => storageForOwner(s.id)))
  ).reduce((sum, v) => sum + v.totalBytes, 0);
  const owned = await prismaSystem.storageObject.aggregate({
    where: { storeId: { not: null }, uploadedAt: { not: null } },
    _sum: { sizeInBytes: true },
  });
  const nobodys = await prismaSystem.storageObject.aggregate({
    where: { storeId: null, uploadedAt: { not: null } },
    _sum: { sizeInBytes: true },
  });
  eq("every owner view together accounts for exactly the rows that have an owner",
    everyOwnerTotal, owned._sum.sizeInBytes ?? 0);
  // NOT VACUOUS: there really are unattributed bytes for it to have excluded.
  assert("and there were unattributed bytes to exclude",
    (nobodys._sum.sizeInBytes ?? 0) > 0, `${nobodys._sum.sizeInBytes}`);
  assert("so not one of them reached an owner",
    everyOwnerTotal !== (owned._sum.sizeInBytes ?? 0) + (nobodys._sum.sizeInBytes ?? 0),
    "an unattributed object was counted against a business");

  const platform = await buildLedgerStorageReport();
  eq("and the operator report agrees about what nobody owns",
    platform.unattributed.bytes, nobodys._sum.sizeInBytes ?? 0);

  // Directly: the query cannot reach a null-store row.
  const rows = await ownedObjects(mine.id);
  eq("the owner query returns only landed, owned rows", rows.length, 3);

  console.log("\n--- an in-flight upload is not a file ---\n");
  eq("the reservation is not counted as a file", ours.fileCount, 3);
  assert("nor are its declared bytes in the total", ours.totalBytes === 4000, `${ours.totalBytes}`);
  {
    // And when it lands, the number goes UP. If a reservation were counted, the
    // total would move the other way when the upload succeeded.
    const before = (await storageForOwner(mine.id)).totalBytes;
    await prismaSystem.storageObject.update({
      where: { pathname: `assets/mine-held-${stamp}.png` },
      data: { sizeInBytes: 1234, uploadedAt: new Date() },
    });
    const after = (await storageForOwner(mine.id)).totalBytes;
    assert("when the upload lands, usage rises rather than falls", after > before, `${before} -> ${after}`);
    eq("by exactly the real size", after - before, 1234);
  }

  console.log("\n--- a business with nothing ---\n");
  const nothing = await storageForOwner(emptyStore.id);
  assert("is empty", nothing.empty);
  eq("with no categories", nothing.categories, []);
  eq("and no bytes", [nothing.totalBytes, nothing.fileCount], [0, 0]);

  console.log("\n--- categories come from the real lifecycle column ---\n");
  const fresh = await storageForOwner(mine.id);
  eq("both classes are present", fresh.categories.map((c) => c.lifecycle).sort(), ["derived", "permanent"]);
  eq("labelled for a person",
    fresh.categories.find((c) => c.lifecycle === "derived")?.label, "Files Genesis can recreate");

  console.log("\n--- and no allowance reached the owner ---\n");
  const json = JSON.stringify(fresh);
  for (const word of ["allowance", "remaining", "percent", "quota", "limit", "plan", "Starter", "5368709120"]) {
    assert(`the owner payload contains no "${word}"`, !json.toLowerCase().includes(word.toLowerCase()), json);
  }

  console.log(`\n${failures} failed, ${passes} passed\n`);
  await prismaSystem.$disconnect();
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
