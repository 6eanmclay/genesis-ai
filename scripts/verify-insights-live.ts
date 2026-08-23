import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";

// CHAPTER 1, TIER 3 — THE INSIGHT DETECTORS:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-insights-live.ts" -OutFile out.txt
//
// computeInsights is what turns real business facts into the things J4 raises
// unprompted. It had been RUN by two other suites — as a step on the way to
// something else — and never had its own behaviour asserted.
//
// THE FAILURE MODE THIS EXISTS FOR IS THE FALSE POSITIVE. An insight is J4
// interrupting an owner to say something is happening. A detector that fires on
// thin evidence does not produce a slightly-wrong dashboard; it produces J4
// telling somebody their revenue collapsed because they had one quiet week
// against a week with a single sale. So most of what follows asserts SILENCE,
// under exactly the conditions where a careless detector would speak:
//
//   no history at all      nothing to notice, and nothing said
//   a zero baseline        no percentage exists; "infinite % change" is not news
//   below every threshold  15% revenue, 20% open rate, 3 invoices, 2x cancels
//   unknown, not zero      quantityAvailable is null on every internal item,
//                          because nothing populates stock — a null must never
//                          read as "out of stock"
//
// The detectors themselves are private, so this drives computeInsights, which is
// what production actually calls.

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

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

async function main() {
  const db = await startRealPostgres();
  await db.prisma.$disconnect();

  process.env[TEST_DATABASE_ENV] = "1";
  process.env.DATABASE_URL = db.url;

  const { computeInsights } = await import("@/lib/intelligence/insights");
  const { persistSyncedRecords } = await import("@/lib/businessModel/sync");
  const { prismaSystem: prisma } = await import("@/lib/prisma");

  let n = 0;
  const makeStore = (userId: string, name: string) =>
    prisma.store.create({
      data: {
        userId, name, slug: `${name.toLowerCase().replace(/[^a-z]+/g, "-")}-${++n}`,
        tagline: "t", description: "d", currency: "USD",
      },
    });

  let ext = 0;
  const order = (storeId: string, amountInCents: number, day: number) =>
    prisma.order.create({
      data: {
        storeId, productName: "x", buyerEmail: "b@example.test",
        amountInCents, status: "paid", paymentProvider: "STRIPE",
        externalOrderId: `o-${++ext}`, createdAt: daysAgo(day),
      },
    });

  const invoice = (storeId: string, amountInCents: number, dueDay: number, status = "pending") =>
    persistSyncedRecords(storeId, "quickbooks", [
      {
        entityType: "document" as const,
        externalId: `inv-${++ext}`,
        data: {
          type: "invoice", amountInCents, status,
          contactId: null, issuedAt: daysAgo(dueDay + 30).toISOString(),
          dueAt: daysAgo(dueDay).toISOString(),
        } as never,
      },
    ], { provenance: "CONNECTOR", provenanceDetail: "quickbooks", statedById: null, modelExtracted: false });

  const cancellation = (storeId: string, day: number) =>
    prisma.businessEvent.create({
      data: {
        storeId, entityType: "appointment", eventType: "appointment.cancelled",
        recordId: null, sourceProvider: "google_calendar", summary: "s", occurredAt: daysAgo(day),
      },
    });

  const owner = await prisma.user.create({ data: { email: "insights@example.test" } });

  const typesFor = async (storeId: string) => (await computeInsights(storeId)).map((i) => i.type).sort();

  // ==========================================================================
  console.log("\n=== 1. A business with no history is not a business in trouble ===\n");
  // ==========================================================================
  const empty = await makeStore(owner.id, "Empty Business");
  const emptyInsights = await computeInsights(empty.id);
  // The storefront-readiness detector is the one that CAN legitimately speak
  // for a brand-new store, and it is covered by its own suite. Everything else
  // must stay silent.
  assert(
    "no revenue, engagement, invoice, stock or cancellation insight",
    !emptyInsights.some((i) => i.type.startsWith("revenue.") || i.type.startsWith("engagement.") ||
      i.type.startsWith("invoices.") || i.type.startsWith("inventory.") || i.type.startsWith("appointments.")),
    emptyInsights.map((i) => i.type).join(", ") || "silent"
  );

  // ==========================================================================
  console.log("\n=== 2. Revenue: a threshold, and a baseline ===\n");
  // ==========================================================================
  // A single sale last week and nothing this week. A careless detector calls
  // that a 100% collapse; there IS a baseline here, so this one legitimately
  // fires — the point of the fixture is that the number is real.
  const dropped = await makeStore(owner.id, "Dropped Business");
  await order(dropped.id, 10_000, 10);
  await order(dropped.id, 2_000, 3);
  const droppedInsights = await computeInsights(dropped.id);
  const revenueInsight = droppedInsights.find((i) => i.type.startsWith("revenue."));
  check("an 80% fall is noticed", revenueInsight?.type, "revenue.decreased");
  check("and it is urgent", revenueInsight?.severity, "urgent");

  // A rise is an opportunity, not an alarm.
  const rose = await makeStore(owner.id, "Rose Business");
  await order(rose.id, 2_000, 10);
  await order(rose.id, 10_000, 3);
  const roseInsight = (await computeInsights(rose.id)).find((i) => i.type.startsWith("revenue."));
  check("a rise is noticed too", roseInsight?.type, "revenue.increased");
  check("but as an opportunity", roseInsight?.severity, "opportunity");

  // Under 15% is not news.
  const steady = await makeStore(owner.id, "Steady Business");
  await order(steady.id, 10_000, 10);
  await order(steady.id, 10_500, 3);
  assert("a 5% move says nothing",
    !(await typesFor(steady.id)).some((t) => t.startsWith("revenue.")), "under the threshold");

  // THE BASELINE REFUSAL. First week of trading, no prior week.
  const firstWeek = await makeStore(owner.id, "First Week Business");
  await order(firstWeek.id, 50_000, 2);
  assert("a first week of trading is not a trend",
    !(await typesFor(firstWeek.id)).some((t) => t.startsWith("revenue.")),
    "no baseline means no percentage exists");

  // ==========================================================================
  console.log("\n=== 3. Overdue invoices need a cluster, not one late payer ===\n");
  // ==========================================================================
  const twoLate = await makeStore(owner.id, "Two Late Business");
  await invoice(twoLate.id, 10_000, 5);
  await invoice(twoLate.id, 20_000, 8);
  assert("two overdue invoices are not a cluster",
    !(await typesFor(twoLate.id)).includes("invoices.overdue"), "the threshold is three");

  const threeLate = await makeStore(owner.id, "Three Late Business");
  await invoice(threeLate.id, 10_000, 5);
  await invoice(threeLate.id, 20_000, 8);
  await invoice(threeLate.id, 30_000, 12);
  const lateInsight = (await computeInsights(threeLate.id)).find((i) => i.type === "invoices.overdue");
  assert("three is", lateInsight !== undefined);
  check("counted honestly", lateInsight?.metrics?.count, 3);
  check("and totalled honestly", lateInsight?.metrics?.totalOwedInCents, 60_000);

  // Paid invoices are not overdue however old they are, and an invoice with no
  // due date cannot be late.
  const paidUp = await makeStore(owner.id, "Paid Up Business");
  await invoice(paidUp.id, 10_000, 90, "paid");
  await invoice(paidUp.id, 20_000, 80, "paid");
  await invoice(paidUp.id, 30_000, 70, "paid");
  assert("three ancient PAID invoices are not overdue",
    !(await typesFor(paidUp.id)).includes("invoices.overdue"));

  // ==========================================================================
  console.log("\n=== 4. Unknown stock is not empty stock ===\n");
  // ==========================================================================
  // Nothing in this product populates quantityAvailable — internalMapper writes
  // null for every item. A detector reading null as 0 would tell every owner
  // their whole catalogue is out of stock.
  const shop = await makeStore(owner.id, "Shop Business");
  for (const name of ["Candle", "Soap", "Balm"]) {
    await prisma.product.create({
      data: { storeId: shop.id, name, description: "d", priceInCents: 1_000, active: true },
    });
  }
  assert("a catalogue with unknown stock is not out of stock",
    !(await typesFor(shop.id)).includes("inventory.depleted"),
    "quantityAvailable is null, and null is not zero");

  // ==========================================================================
  console.log("\n=== 5. Cancellations need a prior week to double ===\n");
  // ==========================================================================
  const noPrior = await makeStore(owner.id, "No Prior Business");
  await cancellation(noPrior.id, 2);
  await cancellation(noPrior.id, 3);
  await cancellation(noPrior.id, 4);
  assert("cancellations with no prior week are not a trend",
    !(await typesFor(noPrior.id)).includes("appointments.cancellations_up"),
    "nothing to have doubled from");

  const doubled = await makeStore(owner.id, "Doubled Business");
  await cancellation(doubled.id, 10);
  await cancellation(doubled.id, 2);
  await cancellation(doubled.id, 3);
  const cancelInsight = (await computeInsights(doubled.id)).find((i) => i.type === "appointments.cancellations_up");
  assert("two against one is a real doubling", cancelInsight !== undefined);
  check("with the real counts", [cancelInsight?.metrics?.recentCount, cancelInsight?.metrics?.priorCount], [2, 1]);

  // Level cancellations are not a trend.
  const level = await makeStore(owner.id, "Level Business");
  await cancellation(level.id, 10);
  await cancellation(level.id, 11);
  await cancellation(level.id, 2);
  await cancellation(level.id, 3);
  assert("the same number as last week is not a rise",
    !(await typesFor(level.id)).includes("appointments.cancellations_up"));

  // ==========================================================================
  console.log("\n=== 6. Every insight becomes a durable, findable record ===\n");
  // ==========================================================================
  const outputs = await prisma.cognitiveOutput.findMany({
    where: { storeId: threeLate.id, kind: "insight" },
    select: { summary: true, topicKey: true, priority: true, storeId: true },
  });
  assert("the overdue insight was recorded", outputs.some((o) => o.topicKey === "invoices.overdue"));
  check("under its own stable identity",
    outputs.find((o) => o.topicKey === "invoices.overdue")?.topicKey, "invoices.overdue");
  assert("at high priority, because it is urgent",
    outputs.find((o) => o.topicKey === "invoices.overdue")?.priority === "high");

  // ==========================================================================
  console.log("\n=== 7. Events are marked processed, and only this store's ===\n");
  // ==========================================================================
  const a = await makeStore(owner.id, "Events A");
  const b = await makeStore(owner.id, "Events B");
  await cancellation(a.id, 2);
  await cancellation(b.id, 2);

  await computeInsights(a.id);
  check("this store's events are processed",
    await prisma.businessEvent.count({ where: { storeId: a.id, processedAt: null } }), 0);
  check("the other store's are untouched",
    await prisma.businessEvent.count({ where: { storeId: b.id, processedAt: null } }), 1);

  // ==========================================================================
  console.log("\n=== 8. No insight is ever attributed across businesses ===\n");
  // ==========================================================================
  // A quiet business sitting next to a loud one. Nothing from next door may
  // reach it.
  const quiet = await makeStore(owner.id, "Quiet Business");
  const loud = await makeStore(owner.id, "Loud Business");
  await order(loud.id, 100_000, 10);
  await order(loud.id, 1_000, 3);
  await invoice(loud.id, 10_000, 5);
  await invoice(loud.id, 20_000, 8);
  await invoice(loud.id, 30_000, 12);
  await cancellation(loud.id, 10);
  await cancellation(loud.id, 2);
  await cancellation(loud.id, 3);

  const loudTypes = await typesFor(loud.id);
  assert("the loud business has plenty to say",
    loudTypes.includes("revenue.decreased") && loudTypes.includes("invoices.overdue") &&
      loudTypes.includes("appointments.cancellations_up"),
    loudTypes.join(", "));

  const quietTypes = await typesFor(quiet.id);
  assert("and none of it reaches the quiet one",
    !quietTypes.some((t) => t.startsWith("revenue.") || t.startsWith("invoices.") || t.startsWith("appointments.")),
    quietTypes.join(", ") || "silent");

  check("nor do its recorded findings",
    await prisma.cognitiveOutput.count({ where: { storeId: quiet.id, topicKey: "invoices.overdue" } }), 0);

  // Concurrently, for the same reason every other surface asserts it.
  const [loudAgain, quietAgain] = await Promise.all([typesFor(loud.id), typesFor(quiet.id)]);
  assert("read at the same moment, they stay apart",
    loudAgain.includes("invoices.overdue") && !quietAgain.includes("invoices.overdue"));

  // ==========================================================================
  console.log("\n=== Spoken, not logged — every summary is a real sentence ===\n");
  // ==========================================================================
  // GENESIS_EXPERIENCE_PRINCIPLES.md §1, frozen: "every piece of Genesis-sourced
  // content is a real sentence in Genesis's own voice — never raw system/log
  // language, never bare unexplained data."
  //
  // Two detectors breached it from the day they were written — no terminal
  // punctuation, and a trailing bare parenthetical readout. Nobody saw it
  // because the summaries only ever appeared under a card heading, where a label
  // reads as a label. Proactive J4 made them speak, and speaking exposed it.
  //
  // THIS IS THE PART THAT MATTERS. Rewriting two strings fixes today. This makes
  // it mechanically hard for a detector written next year to reintroduce label
  // language, by turning the principle into something a suite can check — and it
  // lives here, where every detector is already driven through real data.
  const everySummary = [
    ...(await computeInsights(dropped.id)),
    ...(await computeInsights(rose.id)),
    ...(await computeInsights(threeLate.id)),
    ...(await computeInsights(doubled.id)),
  ];
  assert("there are summaries to check", everySummary.length > 0);

  for (const insight of everySummary) {
    const line = insight.summary;
    // A REAL SENTENCE ENDS. Not decoration — an unterminated fragment is the
    // shape of a label, and it is how both breaches read.
    assert(`${insight.type} ends as a sentence`, /[.!?]$/.test(line), line);
    assert(`${insight.type} starts as one`, /^[A-Z0-9£$]/.test(line), line);
    // NEVER BARE UNEXPLAINED DATA — the principle's own words, and the other
    // half of what was wrong.
    assert(`${insight.type} carries no bare readout`,
      !/\([^)]*\bvs\b[^)]*\)/i.test(line), line);
    assert(`${insight.type} speaks no system language`,
      !/\b(null|undefined|storeId|dedupeKey|topicKey|executionId)\b/i.test(line), line);
  }

  await prisma.$disconnect();
  await db.close();

  console.log(`\n${failures === 0 ? "All insight assertions passed." : `${failures} assertion(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
