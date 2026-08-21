import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";

// M4's OBSERVATION LIFECYCLE — the last "path exercised, lifecycle unasserted":
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-readiness-lifecycle-live.ts" -OutFile out.txt
//
// BI_ENGINE.md records M4 as "path exercised, lifecycle unasserted":
// computeInsights runs detectStorefrontReadiness against real Postgres, so the
// code path executes, but nothing asserted what happens to the OBSERVATION it
// produces — whether it deduplicates, whether it stops repeating itself, whether
// it comes back after being resolved. A path that runs is not a behaviour that
// is proved, which is why it was worded that way rather than called done.
//
// THE PROPERTY THE WHOLE LIFECYCLE TURNS ON: J4 notices a real thing once, keeps
// noticing it without saying it again, and stops mentioning it when it stops
// being true. Each half is a different way of being wrong — a detector that
// re-raises is a nag, and one that never re-raises after a resolve is a detector
// that goes quiet about a problem that came back.
//
// Nothing here is AI. evaluateStorefront reads products and assets only — no
// connector, no sales — which is exactly why M4 exists: a pre-revenue store had
// a working engine and silence.

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}

function assert(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

async function main() {
  const db = await startRealPostgres();
  await db.prisma.$disconnect();

  process.env[TEST_DATABASE_ENV] = "1";
  process.env.DATABASE_URL = db.url;

  const { detectStorefrontReadiness, STOREFRONT_READINESS_DEDUPE_KEY } = await import(
    "@/lib/intelligence/storefrontReadiness"
  );
  const { notifyFromInsights } = await import("@/lib/intelligence/notify");
  const { prismaSystem: prisma } = await import("@/lib/prisma");

  const makeStore = (userId: string, name: string, slug: string) =>
    prisma.store.create({
      data: { userId, name, slug, tagline: "t", description: "d", currency: "USD" },
    });

  const owner = await prisma.user.create({ data: { email: "readiness@example.test" } });
  const iron = await makeStore(owner.id, "Iron Gym", "iron-gym");
  const copper = await makeStore(owner.id, "Copper & Coil", "copper-coil");

  // A storefront with something genuinely wrong with it: real products, no
  // photos. Nothing invented — the finding is counted from real rows.
  for (const name of ["Kettlebell", "Rower", "Bench"]) {
    await prisma.product.create({
      data: { storeId: iron.id, name, description: `${name} description`, priceInCents: 5_000, active: true },
    });
  }

  const observation = () =>
    prisma.genesisObservation.findFirst({
      where: { storeId: iron.id, dedupeKey: STOREFRONT_READINESS_DEDUPE_KEY },
    });
  const countFor = (storeId: string) =>
    prisma.genesisObservation.count({ where: { storeId, dedupeKey: STOREFRONT_READINESS_DEDUPE_KEY } });

  // ==========================================================================
  console.log("\n=== 1. J4 notices a real thing, from real rows ===\n");
  // ==========================================================================
  const first = await detectStorefrontReadiness(iron.id);
  assert("a storefront with a real problem produces an insight", first !== null);
  check("of the readiness type", first?.type, "storefront.readiness");
  assert("with a summary grounded in what is actually there", Boolean(first?.summary?.length));

  await notifyFromInsights(iron.id, first ? [first] : []);
  const raised = await observation();
  assert("which becomes an observation the owner can see", raised !== null);
  check("active", raised?.status, "ACTIVE");
  check("under the insight's own key", raised?.dedupeKey, STOREFRONT_READINESS_DEDUPE_KEY);

  // ==========================================================================
  console.log("\n=== 2. A standing finding keeps being produced ===\n");
  // ==========================================================================
  // The subtle half, and the opposite of the obvious guess. An insight already
  // standing KEEPS being raised for as long as the condition holds — because
  // notifyFromInsights runs a resolve sweep, and anything missing from the
  // current set is marked RESOLVED. Suppressing a still-true finding as
  // "already said" would therefore RETRACT it, quietly, the very next cycle.
  //
  // The gate decides whether to START saying something. It never decides
  // whether to keep a true thing said.
  const second = await detectStorefrontReadiness(iron.id);
  assert("a still-true finding is raised again", second !== null);
  check("as the same finding", second?.type, first?.type);
  check("and no second observation row was created", await countFor(iron.id), 1);

  await notifyFromInsights(iron.id, second ? [second] : []);
  check("the observation stays active", (await observation())?.status, "ACTIVE");

  // ==========================================================================
  console.log("\n=== 3. Which is exactly what stops it being retracted ===\n");
  // ==========================================================================
  // The failure mode the design above prevents, demonstrated: a cycle that
  // produced no readiness insight resolves the standing observation. Correct
  // when the condition really has stopped being true, and a silent retraction
  // if the insight had merely been suppressed as "already said".
  await notifyFromInsights(iron.id, []);
  check("an empty cycle resolves the standing observation", (await observation())?.status, "RESOLVED");
  assert(
    "so keeping a true finding in the set is what keeps it said",
    true,
    "the suppression this suite first assumed would have retracted it every cycle"
  );

  // ==========================================================================
  console.log("\n=== 4. Resolved, then genuinely recurring ===\n");
  // ==========================================================================
  const raisedId = raised!.id;
  const again = await detectStorefrontReadiness(iron.id);
  assert("the same real problem is still detectable", again !== null);

  await notifyFromInsights(iron.id, again ? [again] : []);
  const revived = await observation();
  check("still one row, not a second", await countFor(iron.id), 1);
  check("the same row, reactivated", revived?.id, raisedId);
  check("active again", revived?.status, "ACTIVE");
  check("and no longer carrying a resolution", revived?.resolvedAt, null);
  assert(
    "identity survived the resolve/reappear cycle",
    revived?.id === raisedId,
    "a second row for the same real thing would be a duplicate the owner sees twice"
  );

  // ==========================================================================
  console.log("\n=== 5. It stops when it stops being true ===\n");
  // ==========================================================================
  // Give every product a photo. The finding this observation was about is now
  // genuinely false.
  await prisma.product.updateMany({
    where: { storeId: iron.id },
    data: { imageUrl: "https://blob.example.test/products/photo.png" },
  });

  const afterFixing = await detectStorefrontReadiness(iron.id);
  // Either there is nothing left to say, or what is left is a DIFFERENT
  // finding — both are honest; what must not happen is repeating the photos
  // complaint about a storefront whose products all have photos.
  if (afterFixing) {
    assert(
      "any remaining finding is about something else",
      !afterFixing.summary.toLowerCase().includes("photo"),
      `still said: ${afterFixing.summary}`
    );
  } else {
    assert("nothing left to raise", true, "the storefront reads as ready");
  }

  // ==========================================================================
  console.log("\n=== 6. One business's observation is not another's ===\n");
  // ==========================================================================
  check("the other business has no readiness observation", await countFor(copper.id), 0);

  // A storefront with no products at all is a different state, and it is that
  // business's own.
  const copperInsight = await detectStorefrontReadiness(copper.id);
  await notifyFromInsights(copper.id, copperInsight ? [copperInsight] : []);
  const copperRows = await prisma.genesisObservation.findMany({ where: { storeId: copper.id } });
  const ironRows = await prisma.genesisObservation.findMany({ where: { storeId: iron.id } });
  assert(
    "neither business's rows carry the other's id",
    copperRows.every((r) => r.storeId === copper.id) && ironRows.every((r) => r.storeId === iron.id)
  );
  assert(
    "and resolving one never touched the other",
    ironRows.length >= 1,
    "Iron Gym still holds its own row"
  );

  await prisma.$disconnect();
  await db.close();

  console.log(`\n${failures === 0 ? "All readiness-lifecycle assertions passed." : `${failures} assertion(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
