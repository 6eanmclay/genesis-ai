import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";

// TIER 3's SECOND GATE — which insights become something the owner SEES:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-notify-live.ts" -OutFile out.txt
//
// notifyFromInsights is a deliberately HIGHER bar than the Insight Engine's own
// thresholds. An insight that clears the first gate is real and reaches Reason's
// prompt context; only some of them should also become an ambient badge on the
// owner's screen. Its own comment: "Purple/Red stays narrow and high-signal"
// rather than diluted with routine noise.
//
// So a 15% revenue drop is a real insight AND deliberately silent as a badge,
// while a 25% drop is both. That gap is the whole design, and nothing asserted
// it — which means nothing would have noticed the two gates collapsing into one.
//
// THE OTHER RISK IS THE RESOLVE SWEEP. Two independent sources write ambient
// observations — this one and the deterministic sweep in genesisObservations.ts —
// and each resolves "everything of mine that is no longer true". Without the
// dedupeKey prefixes they namespace on, either sweep would silently wipe the
// other's genuinely-still-active rows, because neither knows the other's keys.
// That is asserted directly here, in both directions.

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}

async function main() {
  const db = await startRealPostgres();
  await db.prisma.$disconnect();

  process.env[TEST_DATABASE_ENV] = "1";
  process.env.DATABASE_URL = db.url;

  const { notifyFromInsights } = await import("@/lib/intelligence/notify");
  const { upsertObservation, resolveMissingObservations } = await import(
    "@/lib/dashboard/genesisObservations"
  );
  const { prismaSystem: prisma } = await import("@/lib/prisma");

  let n = 0;
  const makeStore = (userId: string, name: string) =>
    prisma.store.create({
      data: {
        userId, name, slug: `${name.toLowerCase().replace(/[^a-z]+/g, "-")}-${++n}`,
        tagline: "t", description: "d", currency: "USD",
      },
    });

  const owner = await prisma.user.create({ data: { email: "notify@example.test" } });

  const insight = (type: string, severity: "urgent" | "opportunity", change?: number) => ({
    type,
    severity,
    summary: `${type} happened`,
    metrics: change === undefined ? {} : { change },
  });

  const activeKeys = async (storeId: string) =>
    (
      await prisma.genesisObservation.findMany({
        where: { storeId, status: "ACTIVE" },
        select: { dedupeKey: true },
      })
    ).map((o) => o.dedupeKey).sort();

  // ==========================================================================
  console.log("\n=== 1. A real insight is not automatically a badge ===\n");
  // ==========================================================================
  const quietDrop = await makeStore(owner.id, "Quiet Drop");
  // 18% is well past the Insight Engine's 15% bar — a real insight — and below
  // the notify bar of 25%.
  await notifyFromInsights(quietDrop.id, [insight("revenue.decreased", "urgent", -0.18) as never]);
  check("an 18% fall is a real insight and NOT an ambient badge", await activeKeys(quietDrop.id), []);

  const loudDrop = await makeStore(owner.id, "Loud Drop");
  await notifyFromInsights(loudDrop.id, [insight("revenue.decreased", "urgent", -0.3) as never]);
  check("a 30% fall is both", await activeKeys(loudDrop.id), ["insight:revenue.decreased"]);

  // Exactly at the bar counts — the comparison is >=, and a boundary that
  // silently excluded the threshold value would be a different rule.
  const exactly = await makeStore(owner.id, "Exactly At Bar");
  await notifyFromInsights(exactly.id, [insight("revenue.decreased", "urgent", -0.25) as never]);
  check("exactly 25% clears it", await activeKeys(exactly.id), ["insight:revenue.decreased"]);

  // ==========================================================================
  console.log("\n=== 2. Some real insights are deliberately never badges ===\n");
  // ==========================================================================
  const improved = await makeStore(owner.id, "Improved Engagement");
  // engagement.improved is a real insight type the engine can produce, and is
  // deliberately absent from the notify map — good news is not an interruption.
  await notifyFromInsights(improved.id, [insight("engagement.improved", "opportunity", 0.9) as never]);
  check("a big engagement improvement stays out of the ambient layer",
    await activeKeys(improved.id), []);

  // An unrecognised type defaults to NOT notifying. A future detector cannot
  // accidentally start badging by existing.
  const unknown = await makeStore(owner.id, "Unknown Type");
  await notifyFromInsights(unknown.id, [insight("something.new", "urgent", 0.99) as never]);
  check("an unlisted insight type does not badge by default", await activeKeys(unknown.id), []);

  // The always-notify ones need no metrics at all.
  const always = await makeStore(owner.id, "Always Notify");
  await notifyFromInsights(always.id, [
    insight("invoices.overdue", "urgent") as never,
    insight("inventory.depleted", "urgent") as never,
    insight("appointments.cancellations_up", "urgent") as never,
  ]);
  check("the three always-worthy ones all badge", await activeKeys(always.id), [
    "insight:appointments.cancellations_up",
    "insight:inventory.depleted",
    "insight:invoices.overdue",
  ]);

  // ==========================================================================
  console.log("\n=== 3. It stops badging when it stops being true ===\n");
  // ==========================================================================
  const recovered = await makeStore(owner.id, "Recovered");
  await notifyFromInsights(recovered.id, [insight("revenue.decreased", "urgent", -0.4) as never]);
  check("the badge is raised", await activeKeys(recovered.id), ["insight:revenue.decreased"]);

  // Next cycle, revenue is fine. The insight is gone from the set, so the badge
  // must be resolved rather than left standing forever.
  await notifyFromInsights(recovered.id, []);
  check("and resolved once it is no longer true", await activeKeys(recovered.id), []);
  check("the row itself survives, resolved rather than deleted",
    await prisma.genesisObservation.count({ where: { storeId: recovered.id } }), 1);

  // And it comes back on the SAME row if the condition returns.
  const before = await prisma.genesisObservation.findFirstOrThrow({ where: { storeId: recovered.id } });
  await notifyFromInsights(recovered.id, [insight("revenue.decreased", "urgent", -0.5) as never]);
  const after = await prisma.genesisObservation.findFirstOrThrow({ where: { storeId: recovered.id } });
  check("a recurrence reactivates the same row", after.id, before.id);
  check("rather than making a second one",
    await prisma.genesisObservation.count({ where: { storeId: recovered.id } }), 1);

  // ==========================================================================
  console.log("\n=== 4. One sweep never wipes the other's rows ===\n");
  // ==========================================================================
  // The reason both sources namespace their dedupeKeys. The deterministic sweep
  // and the insight sweep both write "urgent" observations and both resolve
  // "everything of mine that is no longer true" — without the prefixes, either
  // would silently resolve the other's genuinely-still-active rows.
  const shared = await makeStore(owner.id, "Shared States");

  await upsertObservation(shared.id, {
    dedupeKey: "deterministic:unfulfilled-orders",
    genesisState: "urgent",
    summary: "Three orders are waiting",
  });
  await notifyFromInsights(shared.id, [insight("invoices.overdue", "urgent") as never]);
  check("both sources have an urgent observation", await activeKeys(shared.id), [
    "deterministic:unfulfilled-orders",
    "insight:invoices.overdue",
  ]);

  // The insight stops being true. Its own sweep must clear only its own row.
  await notifyFromInsights(shared.id, []);
  check("the insight sweep resolves only the insight", await activeKeys(shared.id), [
    "deterministic:unfulfilled-orders",
  ]);

  // And the other direction: the deterministic sweep clears only its own.
  await notifyFromInsights(shared.id, [insight("invoices.overdue", "urgent") as never]);
  await resolveMissingObservations(shared.id, [], "urgent", "deterministic:");
  check("the deterministic sweep resolves only the deterministic one",
    await activeKeys(shared.id), ["insight:invoices.overdue"]);

  // ==========================================================================
  console.log("\n=== 5. Resolving is scoped per state, not across them ===\n");
  // ==========================================================================
  const states = await makeStore(owner.id, "Two States");
  await notifyFromInsights(states.id, [
    insight("revenue.increased", "opportunity", 0.6) as never,
    insight("invoices.overdue", "urgent") as never,
  ]);
  check("both states are raised", await activeKeys(states.id), [
    "insight:invoices.overdue",
    "insight:revenue.increased",
  ]);

  // The urgent one stops being true; the opportunity is unchanged.
  await notifyFromInsights(states.id, [insight("revenue.increased", "opportunity", 0.6) as never]);
  check("only the state that went away is resolved", await activeKeys(states.id), [
    "insight:revenue.increased",
  ]);

  // ==========================================================================
  console.log("\n=== 6. Badges never cross businesses ===\n");
  // ==========================================================================
  const a = await makeStore(owner.id, "Business A");
  const b = await makeStore(owner.id, "Business B");
  await notifyFromInsights(a.id, [insight("invoices.overdue", "urgent") as never]);
  check("A has its badge", await activeKeys(a.id), ["insight:invoices.overdue"]);
  check("B has none", await activeKeys(b.id), []);

  // A's sweep resolving must never reach into B.
  await notifyFromInsights(b.id, [insight("inventory.depleted", "urgent") as never]);
  await notifyFromInsights(a.id, []);
  check("A's resolve clears only A", await activeKeys(a.id), []);
  check("B keeps its own", await activeKeys(b.id), ["insight:inventory.depleted"]);

  await prisma.$disconnect();
  await db.close();

  console.log(`\n${failures === 0 ? "All notification assertions passed." : `${failures} assertion(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
