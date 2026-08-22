import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";

// WHAT THE DAILY BRIEFING IS ALLOWED TO KNOW:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-briefing-grounding-live.ts" -OutFile out.txt
//
// The "since you were last here" briefing is the first thing an owner reads each
// day, and it is written by a model. The model is not the safeguard — the
// CHANGE SET it is handed is, because a model can only be as truthful as the
// facts it is given.
//
// composeOwnerBriefing itself calls a real provider, so it is externally blocked
// here. Everything underneath it is not, and that is the half that decides
// whether a fabricated recap is even possible.
//
// THE DISTINCTION THIS SUITE EXISTS FOR. "There was no last visit" and "nothing
// happened since your last visit" are different facts, and collapsing them
// produces the exact sentence the prompt forbids: a fabricated "nothing changed
// since we last spoke" said to somebody Genesis has never spoken to. The change
// set carries hasPriorAnchor precisely to keep them apart, and the two cases are
// asserted here to be genuinely distinguishable.
//
// Everything else is windowing: a figure that includes activity from before the
// anchor is not "what changed since you were last here", it is a total wearing
// that sentence.

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

  const { getPreviousBriefingAnchor, getChangeSetSince } = await import(
    "@/lib/dashboard/genesisBriefingComposer"
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

  const owner = await prisma.user.create({ data: { email: "briefing@example.test" } });

  let ext = 0;
  const order = (storeId: string, amountInCents: number, day: number, status = "paid", email = "b@example.test") =>
    prisma.order.create({
      data: {
        storeId, productName: "x", buyerEmail: email,
        amountInCents, status, paymentProvider: "STRIPE",
        externalOrderId: `b-${++ext}`, createdAt: daysAgo(day),
      },
    });

  const event = (storeId: string, summary: string, day: number) =>
    prisma.businessEvent.create({
      data: {
        storeId, entityType: "document", eventType: "invoice.paid", recordId: null,
        sourceProvider: "quickbooks", summary, occurredAt: daysAgo(day),
      },
    });

  const briefing = (storeId: string, day: number, status = "ACTIVE") =>
    prisma.cognitiveOutput.create({
      data: {
        storeId, kind: "briefing", summary: "a previous briefing",
        status, generatedAt: daysAgo(day),
      },
    });

  // ==========================================================================
  console.log("\n=== 1. There was no last visit, which is not 'nothing changed' ===\n");
  // ==========================================================================
  const fresh = await makeStore(owner.id, "First Visit Store");
  // Real activity exists — this store is not empty, it has simply never been
  // briefed before.
  await order(fresh.id, 5_000, 2);
  await event(fresh.id, "Invoice paid (£120)", 1);

  check("a store never briefed has no anchor", await getPreviousBriefingAnchor(fresh.id), null);

  const firstTime = await getChangeSetSince(fresh.id, null);
  check("and its change set says so", firstTime.hasPriorAnchor, false);
  check("with no 'since' to report", firstTime.sinceIso, null);
  // THE ASSERTION THAT MATTERS. Real orders and events exist, and the change
  // set still reports nothing — because "what changed since last time" is not a
  // question that has an answer yet.
  check("no order count is claimed", firstTime.orderCount, 0);
  check("no revenue delta", firstTime.revenueDeltaInCents, 0);
  check("no new customers", firstTime.newCustomerCount, 0);
  check("and no activity list", firstTime.recentBusinessEvents, []);
  assert(
    "so a first briefing cannot say 'nothing changed since we last spoke'",
    firstTime.hasPriorAnchor === false,
    "there was no last time, and the flag is what keeps that distinguishable"
  );

  // ==========================================================================
  console.log("\n=== 2. A genuinely quiet day looks different from a first day ===\n");
  // ==========================================================================
  const quiet = await makeStore(owner.id, "Quiet Store");
  const quietAnchor = await briefing(quiet.id, 1);
  // Nothing at all has happened since yesterday's briefing.
  const quietSet = await getChangeSetSince(quiet.id, quietAnchor.generatedAt);

  check("a quiet day DOES have an anchor", quietSet.hasPriorAnchor, true);
  assert("and names when Genesis last spoke", quietSet.sinceIso !== null);
  check("while reporting honest zeros",
    [quietSet.orderCount, quietSet.revenueDeltaInCents, quietSet.newCustomerCount], [0, 0, 0]);
  assert(
    "so the two silent cases are genuinely distinguishable",
    quietSet.hasPriorAnchor !== firstTime.hasPriorAnchor,
    "identical numbers, different facts — only the flag separates them"
  );

  // ==========================================================================
  console.log("\n=== 3. The window is a window, not a total ===\n");
  // ==========================================================================
  const busy = await makeStore(owner.id, "Busy Store");
  await briefing(busy.id, 7);

  // Before the anchor — must be excluded, or "since you were last here" becomes
  // a lifetime total wearing that sentence.
  await order(busy.id, 900_000, 20, "paid", "old-customer@example.test");
  await event(busy.id, "Something from before the anchor", 20);
  // After it.
  await order(busy.id, 10_000, 5, "paid", "new-one@example.test");
  await order(busy.id, 15_000, 3, "paid", "another@example.test");
  await event(busy.id, "Invoice paid (£150)", 4);
  await event(busy.id, "Appointment cancelled", 2);

  const since = await getPreviousBriefingAnchor(busy.id);
  const changeSet = await getChangeSetSince(busy.id, since);

  check("only orders since the anchor are counted", changeSet.orderCount, 2);
  check("and only their revenue", changeSet.revenueDeltaInCents, 25_000);
  assert("the 900,000 from before is excluded",
    changeSet.revenueDeltaInCents === 25_000, "it would be unmissable if counted");
  check("only events since the anchor are listed", changeSet.recentBusinessEvents.length, 2);
  assert("and none of them is the older one",
    !changeSet.recentBusinessEvents.some((e) => e.summary.includes("before the anchor")),
    JSON.stringify(changeSet.recentBusinessEvents));
  check("newest activity first",
    changeSet.recentBusinessEvents.map((e) => e.summary),
    ["Appointment cancelled", "Invoice paid (£150)"]);

  // The summaries are real event text passed through, never regenerated — the
  // briefing quotes what actually happened rather than a paraphrase of it.
  const realSummaries = (
    await prisma.businessEvent.findMany({
      where: { storeId: busy.id, occurredAt: { gte: since! } },
      select: { summary: true },
    })
  ).map((e) => e.summary).sort();
  check("the summaries are the real event text",
    changeSet.recentBusinessEvents.map((e) => e.summary).sort(), realSummaries);

  // ==========================================================================
  console.log("\n=== 4. Revenue is money kept, not money taken ===\n");
  // ==========================================================================
  const refunded = await makeStore(owner.id, "Refunded Store");
  const refundAnchor = await briefing(refunded.id, 7);
  await order(refunded.id, 20_000, 5);
  await order(refunded.id, 8_000, 4, "refunded");

  const refundSet = await getChangeSetSince(refunded.id, refundAnchor.generatedAt);
  check("both orders are counted as orders", refundSet.orderCount, 2);
  check("but the refunded one does not count as revenue", refundSet.revenueDeltaInCents, 12_000);
  assert(
    "so a refunded week is never reported as a good one",
    refundSet.revenueDeltaInCents < 20_000,
    "a briefing quoting gross would congratulate an owner on money they gave back"
  );

  // ==========================================================================
  console.log("\n=== 5. The anchor is the last time Genesis spoke ===\n");
  // ==========================================================================
  const multi = await makeStore(owner.id, "Multi Briefing Store");
  await briefing(multi.id, 30);
  const superseded = await briefing(multi.id, 10, "SUPERSEDED");
  await briefing(multi.id, 20);

  const latest = await getPreviousBriefingAnchor(multi.id);
  check("the most recent briefing is the anchor",
    latest?.toISOString(), superseded.generatedAt.toISOString());
  assert(
    "even when it was superseded, because it still marks when Genesis spoke",
    latest?.getTime() === superseded.generatedAt.getTime(),
    "any status counts — the owner still read it"
  );

  // Other kinds of cognitive output are not briefings and must not anchor one.
  const other = await makeStore(owner.id, "Other Kind Store");
  await prisma.cognitiveOutput.create({
    data: { storeId: other.id, kind: "recommendation", summary: "not a briefing", status: "ACTIVE" },
  });
  check("a recommendation is not a briefing anchor", await getPreviousBriefingAnchor(other.id), null);

  // ==========================================================================
  console.log("\n=== 6. The activity list is capped, and the counts are not ===\n");
  // ==========================================================================
  const noisy = await makeStore(owner.id, "Noisy Store");
  const noisyAnchor = await briefing(noisy.id, 7);
  for (let i = 0; i < 25; i++) await event(noisy.id, `Event ${i}`, 6);
  for (let i = 0; i < 25; i++) await order(noisy.id, 1_000, 6, "paid", `buyer-${i}@example.test`);

  const noisySet = await getChangeSetSince(noisy.id, noisyAnchor.generatedAt);
  check("the activity list is capped at fifteen", noisySet.recentBusinessEvents.length, 15);
  // The counts are true totals, so the briefing's NUMBERS are never truncated —
  // only the illustrative list is, which understates rather than overstates.
  check("but the order count is the real total", noisySet.orderCount, 25);
  check("and the revenue is all of it", noisySet.revenueDeltaInCents, 25_000);
  assert(
    "so truncation can only ever understate activity, never invent it",
    noisySet.recentBusinessEvents.length < noisySet.orderCount,
    "the safe direction: a briefing may mention fewer things than happened"
  );

  // ==========================================================================
  console.log("\n=== 7. One business is never briefed about another ===\n");
  // ==========================================================================
  const neighbour = await makeStore(owner.id, "Neighbour Store");
  const neighbourAnchor = await briefing(neighbour.id, 7);
  const neighbourSet = await getChangeSetSince(neighbour.id, neighbourAnchor.generatedAt);

  check("a quiet neighbour reports nothing", neighbourSet.orderCount, 0);
  check("no revenue from next door", neighbourSet.revenueDeltaInCents, 0);
  check("and none of their activity", neighbourSet.recentBusinessEvents, []);
  assert("even though the store beside it was busy",
    (await getChangeSetSince(busy.id, since)).orderCount > 0,
    "so the silence is isolation, not an empty database");

  const [a, b] = await Promise.all([
    getChangeSetSince(busy.id, since),
    getChangeSetSince(neighbour.id, neighbourAnchor.generatedAt),
  ]);
  assert("concurrent reads stay separate", a.orderCount === 2 && b.orderCount === 0,
    `${a.orderCount} vs ${b.orderCount}`);

  // A different account's anchor never leaks either.
  const stranger = await prisma.user.create({ data: { email: "briefing-stranger@example.test" } });
  const theirs = await makeStore(stranger.id, "Stranger Store");
  check("another account's store has its own anchor", await getPreviousBriefingAnchor(theirs.id), null);

  await prisma.$disconnect();
  await db.close();

  console.log(`\n${failures === 0 ? "All briefing-grounding assertions passed." : `${failures} assertion(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
