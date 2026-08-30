import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { buildLedgerStorageReport } from "@/lib/storage/ledgerReport";

// THE OPERATOR STORAGE VIEW, AGAINST A REAL DATABASE:
//
//   part of the database sweep — npx tsx scripts/run-db-suites.ts ledger-report-db
//
// ============ WHAT MATTERS MOST HERE (2026-08-30) ======================
//
// Two things, and neither is the arithmetic.
//
// The first is that no business's bytes leak into another's line. The report
// crosses tenants by necessity, which is exactly why it is worth proving that
// it separates them correctly rather than trusting that it does.
//
// The second is that NO ALLOWANCE APPEARS ANYWHERE. Sean, 2026-08-30: "Do not
// decide or imply that planless stores are entitled to 5 GB." A number that
// exists gets quoted, so the test asserts over the serialised report that the
// number does not exist — including on a store that genuinely has no plan,
// which is all sixteen of them in production.

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
  const user = await prisma.user.create({ data: { email: `lr-${stamp}@example.test`, name: "Owner" } });

  const plan = await prisma.plan.create({
    data: { name: `LR Plan ${stamp}`, priceInCents: 2000, includedStorageBytes: BigInt(5 * 1024 ** 3) },
  });
  // One store WITH a plan and one on none — the second is what production
  // actually looks like, sixteen times over.
  const onPlan = await prisma.store.create({
    data: { userId: user.id, name: "OnPlan", slug: `lr-a-${stamp}`, tagline: "t", description: "d", planId: plan.id },
  });
  const planless = await prisma.store.create({
    data: { userId: user.id, name: "Planless", slug: `lr-b-${stamp}`, tagline: "t", description: "d" },
  });

  const object = (pathname: string, storeId: string | null, sizeInBytes: number, lifecycle: string, extra: Record<string, unknown> = {}) =>
    prismaSystem.storageObject.create({
      data: {
        pathname, url: `https://blob.test/${pathname}`, storeId,
        attribution: storeId ? "owner" : "unattributed",
        lifecycle, prefix: pathname.slice(0, pathname.indexOf("/") + 1),
        source: "test", sizeInBytes, uploadedAt: new Date(), ...extra,
      },
    });

  await object(`assets/a-${stamp}.png`, onPlan.id, 1000, "permanent");
  await object(`products/b-${stamp}.png`, onPlan.id, 2500, "permanent");
  await object(`printfiles/c-${stamp}.png`, onPlan.id, 500, "derived");
  await object(`assets/d-${stamp}.png`, planless.id, 700, "permanent");
  await object(`assets/orphan-${stamp}.png`, null, 90, "permanent");
  await object(`products/orphan2-${stamp}.png`, null, 10, "permanent");
  // A live reservation: declared, not landed.
  await prismaSystem.storageObject.create({
    data: {
      pathname: `assets/held-${stamp}.png`, storeId: onPlan.id, attribution: "owner",
      lifecycle: "permanent", prefix: "assets/", source: "test",
      declaredBytes: 999_999, uploadedAt: null,
    },
  });

  const report = await buildLedgerStorageReport();
  const mine = report.stores.find((s) => s.storeId === onPlan.id)!;
  const theirs = report.stores.find((s) => s.storeId === planless.id)!;

  console.log("\n--- per-store usage and file counts ---\n");
  eq("the store's file count excludes its reservation", mine.objects, 3);
  eq("and its bytes are the landed ones only", mine.bytes, 4000);
  eq("the reservation is reported separately, never mixed in", mine.reservations, { objects: 1, declaredBytes: 999_999 });
  eq("the other store sees only its own", [theirs.objects, theirs.bytes], [1, 700]);
  assert("stores are ordered by what they use", report.stores[0].bytes >= report.stores[1].bytes);

  console.log("\n--- no business's bytes reach another ---\n");
  const total = report.stores.reduce((s, x) => s + x.bytes, 0);
  eq("no store's bytes appear in another's line", total, 4700);
  eq("the platform total is every landed object, owned or not", report.platform.bytes, 4800);
  assert("so the unattributed are in the platform total but in nobody's line",
    report.platform.bytes - total === report.unattributed.bytes,
    `${report.platform.bytes} - ${total} vs ${report.unattributed.bytes}`);

  console.log("\n--- lifecycle breakdown ---\n");
  const permanent = mine.byLifecycle.find((l) => l.lifecycle === "permanent");
  const derived = mine.byLifecycle.find((l) => l.lifecycle === "derived");
  eq("permanent is counted", [permanent?.objects, permanent?.bytes], [2, 3500]);
  eq("derived is counted separately", [derived?.objects, derived?.bytes], [1, 500]);

  console.log("\n--- the objects nobody owns ---\n");
  eq("they are counted", [report.unattributed.objects, report.unattributed.bytes], [2, 100]);
  eq("and broken down by prefix so an operator can go and look",
    report.unattributed.byPrefix.map((p) => [p.prefix, p.objects]), [["assets/", 1], ["products/", 1]]);

  console.log("\n--- NO ALLOWANCE APPEARS, ANYWHERE ---\n");
  // THE DATA, WITHOUT THE PROSE. `notes` legitimately contains the sentence
  // "No storage allowance appears here" — an explanation of the absence, which
  // is not the thing being guarded against. Scanning it caught that note and
  // called it a leak, which would have made the check something to work around
  // rather than something to trust. What must never carry an allowance is a
  // FIELD, because a field is what gets rendered.
  const { notes: _notes, ...data } = report;
  const serialised = JSON.stringify(data);
  eq("the planless store reports its plan as null, not as a fallback", theirs.planName, null);
  eq("a store with a plan reports the plan it is actually on", mine.planName, `LR Plan ${stamp}`);
  for (const word of ["allowance", "remaining", "percent", "quota", "limit", "Starter"]) {
    assert(`no field in the report mentions "${word}"`, !serialised.toLowerCase().includes(word.toLowerCase()));
  }
  // The specific number that must never be implied.
  assert("and not the 5 GB figure the fallback would have supplied",
    !serialised.includes("5368709120") && !serialised.includes("5 GB"), "the borrowed allowance leaked into the report");

  console.log("\n--- drift is opt-in, and read-only ---\n");
  eq("it is absent unless asked for", report.drift, null);
  {
    const before = await prismaSystem.storageEvent.count();
    const withDrift = await buildLedgerStorageReport({
      includeDrift: true,
      // The provider, injected: one object that does not exist in the ledger,
      // one that does but at the wrong size, and one row whose blob is absent.
      listObjects: async () => ({
        truncated: false,
        objects: [
          { pathname: `assets/a-${stamp}.png`, url: "u", size: 1000 },
          { pathname: `products/b-${stamp}.png`, url: "u", size: 9999 },
          { pathname: `assets/ghost-${stamp}.png`, url: "u", size: 5 },
        ],
      }),
    });
    const drift = withDrift.drift!;
    assert("drift is present when asked for", !!drift);
    eq("a blob with no row is an orphan", drift.orphanBlobs.map((o) => o.pathname), [`assets/ghost-${stamp}.png`]);
    eq("a size disagreement is reported with both figures",
      drift.sizeDisagreements.map((s) => [s.recorded, s.actual]), [[2500, 9999]]);
    assert("rows whose blobs are absent are reported", drift.missingBlobs.length > 0, `${drift.missingBlobs.length}`);
    assert("and it is not in sync", !drift.inSync);
    assert("the deploy gap is named rather than reported as a leak",
      withDrift.notes.some((n) => n.includes("deploy gap")), JSON.stringify(withDrift.notes));

    eq("looking at drift wrote no events", await prismaSystem.storageEvent.count(), before);
    eq("and corrected nothing — the wrong size is still recorded",
      (await prismaSystem.storageObject.findUnique({ where: { pathname: `products/b-${stamp}.png` } }))?.sizeInBytes, 2500);
    eq("and the absent row was not removed",
      await prismaSystem.storageObject.count({ where: { pathname: `printfiles/c-${stamp}.png` } }), 1);
  }

  console.log(`\n${failures} failed, ${passes} passed\n`);
  await prismaSystem.$disconnect();
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
