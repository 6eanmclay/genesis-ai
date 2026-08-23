import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { speakNewFindings, proactiveMessageFor } from "@/lib/intelligence/proactive";
import { upsertObservation, resolveMissingObservations } from "@/lib/dashboard/genesisObservations";
import { messageStateOf } from "@/lib/j4/messageState";
import { EXECUTION_ACTIONS } from "@/lib/execution/actions";
import { readFileSync } from "fs";
import { join } from "path";

// J4 SPEAKING FIRST, and only when it should:
//
//   npx tsx scripts/run-db-suites.ts proactive-j4
//
// The engine was already built — cycle, detectors, findings lifecycle, beliefs.
// What was missing was that nothing ever wrote an unprompted assistant message,
// so J4's proactivity was cards, and cards are software.
//
// The hard part is not saying something. It is saying it ONCE. notifyFromInsights
// deliberately keeps re-confirming a standing finding, because suppressing a
// still-true finding would silently retract it — a card can be re-raised every
// cycle harmlessly, and a sentence cannot. Most of this suite is that.

let failures = 0;
const results: { name: string; ok: boolean }[] = [];

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ name, ok });
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}

function assert(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok });
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const uniq = () => Math.random().toString(36).slice(2, 10);

const assistantMessages = (storeId: string) =>
  prisma.storeMessage.findMany({
    where: { storeId, role: "assistant" },
    orderBy: { createdAt: "asc" },
    include: { executionLog: { select: { status: true, retryable: true, metadata: true } } },
  });

async function main() {
  await requireTestDatabase(prismaSystem);

  const owner = await prisma.user.create({ data: { email: `pj-${uniq()}@test.local` } });
  const shop = await prisma.store.create({
    data: { userId: owner.id, name: "Copper & Coil", slug: `pj-${uniq()}` },
  });
  const neighbour = await prisma.store.create({
    data: { userId: owner.id, name: "Iron Gym", slug: `pj-n-${uniq()}` },
  });

  // ==========================================================================
  console.log("\n=== 1. A qualifying finding produces exactly one message ===\n");
  // ==========================================================================
  check("nothing to say means nothing is said",
    await speakNewFindings(shop.id), { spoken: 0, closed: 0 });
  check("and no message was written",
    (await assistantMessages(shop.id)).length, 0);

  await upsertObservation(shop.id, {
    dedupeKey: "insight:revenue.decreased",
    genesisState: "urgent",
    summary: "Revenue is down 40% on last month.",
    actionHref: null,
  });

  check("a standing finding is spoken once", (await speakNewFindings(shop.id)).spoken, 1);
  const afterFirst = await assistantMessages(shop.id);
  check("exactly one message exists", afterFirst.length, 1);
  assert("carrying the finding's own words",
    afterFirst[0].content.includes("Revenue is down 40% on last month."), afterFirst[0].content);
  // The detector's line and the card's line are the same line. Two descriptions
  // of one finding is how the conversation and the dashboard start disagreeing.
  assert("which are the words the card shows",
    afterFirst[0].content.includes("Revenue is down 40% on last month."),
    "the summary is the single owner-facing description of a finding");

  // ==========================================================================
  console.log("\n=== 2. Repeated cycles do not repeat the sentence ===\n");
  // ==========================================================================
  // THE CENTRAL PROPERTY. A cycle runs on a schedule and a standing finding is
  // re-confirmed every pass by design.
  for (let cycle = 0; cycle < 5; cycle++) {
    await upsertObservation(shop.id, {
      dedupeKey: "insight:revenue.decreased",
      genesisState: "urgent",
      summary: "Revenue is down 40% on last month.",
      actionHref: null,
    });
    check(`cycle ${cycle + 2} says nothing new`, (await speakNewFindings(shop.id)).spoken, 0);
  }
  check("still exactly one message after six cycles",
    (await assistantMessages(shop.id)).length, 1);

  // ==========================================================================
  console.log("\n=== 7. A standing finding stays active without being re-said ===\n");
  // ==========================================================================
  const standing = await prisma.genesisObservation.findFirstOrThrow({
    where: { storeId: shop.id, dedupeKey: "insight:revenue.decreased" },
  });
  check("the finding is still active", standing.status, "ACTIVE");
  check("and its delivery is still open",
    await prisma.proactiveDelivery.count({ where: { observationId: standing.id, closedAt: null } }), 1);
  // The card and the sentence have different lifetimes on purpose.
  assert("so the card may persist while the sentence does not repeat",
    standing.status === "ACTIVE" && (await assistantMessages(shop.id)).length === 1,
    "a card re-raised every cycle is harmless; a sentence re-said every cycle is a feed");

  // ==========================================================================
  console.log("\n=== 3. A different business cannot receive it ===\n");
  // ==========================================================================
  check("the neighbour heard nothing", (await assistantMessages(neighbour.id)).length, 0);
  check("and has no delivery of its own",
    await prisma.proactiveDelivery.count({ where: { storeId: neighbour.id } }), 0);
  // Running the neighbour's own cycle must not pick up this store's finding.
  check("running the neighbour's cycle says nothing",
    (await speakNewFindings(neighbour.id)).spoken, 0);
  check("the neighbour still has no messages",
    (await assistantMessages(neighbour.id)).length, 0);
  check("and this store still has exactly one",
    (await assistantMessages(shop.id)).length, 1);

  // ==========================================================================
  console.log("\n=== 4. Dismissed and resolved findings do not speak ===\n");
  // ==========================================================================
  await upsertObservation(shop.id, {
    dedupeKey: "insight:stock.low",
    genesisState: "opportunity",
    summary: "Two products are nearly out of stock.",
    actionHref: null,
  });
  await prisma.genesisObservation.updateMany({
    where: { storeId: shop.id, dedupeKey: "insight:stock.low" },
    data: { status: "DISMISSED", dismissedAt: new Date() },
  });
  check("a dismissed finding is never spoken", (await speakNewFindings(shop.id)).spoken, 0);
  assert("nothing mentions it",
    !(await assistantMessages(shop.id)).some((m) => m.content.includes("nearly out of stock")),
    "an owner who waved a finding away must not be told about it again");

  // ==========================================================================
  console.log("\n=== 8. Re-engagement, and only under the stated rule ===\n");
  // ==========================================================================
  // THE RULE: a delivery is closed when its finding stops being ACTIVE, and a
  // finding may be spoken about again only once it has genuinely come back.
  // Nothing else releases it.
  await resolveMissingObservations(shop.id, [], "urgent", "insight:");
  const resolved = await prisma.genesisObservation.findFirstOrThrow({
    where: { storeId: shop.id, dedupeKey: "insight:revenue.decreased" },
  });
  check("the finding is resolved", resolved.status, "RESOLVED");

  const afterResolve = await speakNewFindings(shop.id);
  check("resolving closes the delivery", afterResolve.closed, 1);
  check("and says nothing, because nothing is true", afterResolve.spoken, 0);

  // WHAT J4 SAID STAYS SAID. A finding disappearing later does not un-say it.
  check("the original message is untouched", (await assistantMessages(shop.id)).length, 1);
  assert("and still says what it said",
    (await assistantMessages(shop.id))[0].content.includes("Revenue is down 40%"),
    "silently retracting history would make the conversation unreliable as a record");

  // The same finding comes back. upsertObservation reuses the row, which is
  // exactly why a plain unique key would have silenced this forever.
  await upsertObservation(shop.id, {
    dedupeKey: "insight:revenue.decreased",
    genesisState: "urgent",
    summary: "Revenue is down again, 25% on last month.",
    actionHref: null,
  });
  const recurrence = await prisma.genesisObservation.findFirstOrThrow({
    where: { storeId: shop.id, dedupeKey: "insight:revenue.decreased" },
  });
  check("the recurrence reuses the same row", recurrence.id, resolved.id);
  check("and J4 may speak again", (await speakNewFindings(shop.id)).spoken, 1);
  const afterRecurrence = await assistantMessages(shop.id);
  check("so there are now two messages", afterRecurrence.length, 2);
  assert("the second carries the new figure",
    afterRecurrence[1].content.includes("25%"), afterRecurrence[1].content);
  // And immediately settles back down.
  check("and it does not repeat from there", (await speakNewFindings(shop.id)).spoken, 0);

  // ==========================================================================
  console.log("\n=== 5. A proposal is never shown as an executed change ===\n");
  // ==========================================================================
  // J4 raised something. Nothing has changed. UI6's state vocabulary is what
  // the owner sees, and it must say so.
  for (const message of afterRecurrence) {
    const state = messageStateOf(
      message.executionLog
        ? {
            status: message.executionLog.status,
            retryable: message.executionLog.retryable,
            kind: (message.executionLog.metadata as { kind?: string } | null)?.kind ?? null,
          }
        : null
    );
    check("a proactive message reads as waiting on the owner", state, "proposed");
    assert("never as a completed change", state !== "done",
      "J4 noticing something is not J4 having changed something");
  }

  check("and it is logged as PENDING, not SUCCESS",
    (await prisma.executionLog.findMany({
      where: { storeId: shop.id, action: EXECUTION_ACTIONS.GENESIS_STORE_MESSAGE },
      select: { status: true },
    })).map((r) => r.status),
    ["PENDING", "PENDING"]);

  // ==========================================================================
  console.log("\n=== 6. Delivery is idempotent, enforced by the database ===\n");
  // ==========================================================================
  // Two cycles overlapping is the ordinary way a duplicate happens. The partial
  // unique index means the loser writes nothing rather than the owner hearing
  // the same thing twice.
  const before = (await assistantMessages(shop.id)).length;
  const concurrent = await Promise.all([
    speakNewFindings(shop.id),
    speakNewFindings(shop.id),
    speakNewFindings(shop.id),
  ]);
  check("three concurrent passes speak nothing new",
    concurrent.reduce((sum, r) => sum + r.spoken, 0), 0);
  check("and no message was added", (await assistantMessages(shop.id)).length, before);

  // Directly: a second open delivery for one finding is refused by the index.
  let refused = false;
  try {
    await prisma.proactiveDelivery.create({
      data: {
        storeId: shop.id,
        observationId: recurrence.id,
        storeMessageId: afterRecurrence[0].id,
      },
    });
  } catch {
    refused = true;
  }
  assert("a second open delivery for one finding is refused",
    refused, "idempotency that depends on remembering to check is not idempotency");

  // ==========================================================================
  console.log("\n=== The cycle actually calls it ===\n");
  // ==========================================================================
  // EVERYTHING ABOVE TESTS speakNewFindings DIRECTLY, which says nothing about
  // whether anything calls it. That is the exact gap that let two defects live
  // this week: approvalAccessibleTo was correct and app/j4 did not use it, and
  // firstRefusedTool was correct while one caller narrowed its argument. A rule
  // nothing invokes is a rule that does not run.
  //
  // Asserted from source because the cycle's other stages reach a model and a
  // scheduler, which this suite has no business exercising to prove one call.
  const cycleSource = readFileSync(
    join(process.cwd(), "lib", "intelligence", "cycle.ts"), "utf8"
  );
  assert("the intelligence cycle speaks new findings",
    cycleSource.includes("await speakNewFindings(storeId)"),
    "without this J4 computes everything and says none of it");
  // AFTER the findings sweep, not before: speaking about the set from before
  // this pass would announce something that may have just stopped being true.
  assert("and does so after the findings sweep",
    cycleSource.indexOf("notifyFromInsights(storeId") < cycleSource.indexOf("speakNewFindings(storeId"),
    "speaking before the sweep would announce a finding that may have just resolved");
  assert("and reports what it said",
    cycleSource.includes("spoken: spoke.spoken"),
    "a cycle summary that cannot say whether J4 spoke is a cycle nobody can audit");

  // ==========================================================================
  console.log("\n=== Authorization is the conversation's, not a new one ===\n");
  // ==========================================================================
  // A proactive message is an ordinary StoreMessage in the store's one
  // conversation, so it inherits that surface's GENESIS_CHAT gate exactly. What
  // must NOT exist is a second read path that renders proactive messages
  // somewhere the conversation's own check does not run.
  const proactiveSource = readFileSync(
    join(process.cwd(), "lib", "intelligence", "proactive.ts"), "utf8"
  );
  assert("proactive messages are written as ordinary conversation rows",
    proactiveSource.includes('role: "assistant"') &&
      !proactiveSource.includes("prismaSystem"),
    "a proactive write that bypassed the tenant client would bypass its guard too");
  assert("and nothing here reads an active-business pointer",
    !proactiveSource.includes("activeStoreId") &&
      !proactiveSource.includes("resolveUserStore") &&
      !proactiveSource.includes("requireStorePermission"),
    "the cycle has no session; a pointer read here would be guessing at a business");

  // ==========================================================================
  console.log("\n=== The sentence itself ===\n");
  // ==========================================================================
  assert("an urgent finding opens as one",
    proactiveMessageFor({ genesisState: "urgent", summary: "X." }).startsWith("Something needs your attention."),
    proactiveMessageFor({ genesisState: "urgent", summary: "X." }));
  assert("an opportunity does not",
    proactiveMessageFor({ genesisState: "opportunity", summary: "X." }).startsWith("I noticed"),
    proactiveMessageFor({ genesisState: "opportunity", summary: "X." }));
  // Nothing about mechanisms. The owner has no idea a cycle, an observation or
  // a detector exists and must not learn it from J4 speaking.
  for (const state of ["urgent", "opportunity"]) {
    const line = proactiveMessageFor({ genesisState: state, summary: "Revenue is down." });
    assert(`the ${state} sentence names no internals`,
      !/observation|finding|cycle|detector|insight|dedupe/i.test(line), line);
  }

  await prisma.store.deleteMany({ where: { id: { in: [shop.id, neighbour.id] } } });
  await prisma.user.deleteMany({ where: { id: owner.id } });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? `ALL PASS (${results.length})` : `${failed.length} of ${results.length} FAILED`}`);
  if (failed.length) console.log(failed.map((f) => `  - ${f.name}`).join("\n"));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
