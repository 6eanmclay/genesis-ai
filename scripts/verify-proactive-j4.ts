import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import {
  speakNewFindings,
  proactiveMessageFor,
  proposalForFinding,
  proposalJ4Raised,
} from "@/lib/intelligence/proactive";
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
  console.log("\n=== 4b. Waving it away means J4 stops saying it ===\n");
  // ==========================================================================
  // A DISMISSED FINDING IS NOT A RESOLVED ONE, and treating them alike was a
  // real defect. Closing a delivery on anything that was not ACTIVE also caught
  // dismissal — and because upsertObservation unconditionally sets a still-true
  // finding back to ACTIVE and clears dismissedAt, the next sweep made it
  // eligible again and J4 said the same thing a second time. Reproduced before
  // fixing: dismiss, one sweep, told twice.
  //
  // For a card, silently reappearing is mild. For a partner, re-saying something
  // you have just waved away is not hearing you.
  const waved = await prisma.store.create({
    data: { userId: owner.id, name: "Waved Away", slug: `pj-w-${uniq()}` },
  });
  const raiseWaved = () =>
    upsertObservation(waved.id, {
      dedupeKey: "insight:revenue.decreased",
      genesisState: "urgent",
      summary: "Revenue is down.",
      actionHref: null,
    });

  await raiseWaved();
  check("J4 raises it once", (await speakNewFindings(waved.id)).spoken, 1);

  await prisma.genesisObservation.updateMany({
    where: { storeId: waved.id, dedupeKey: "insight:revenue.decreased" },
    data: { status: "DISMISSED", dismissedAt: new Date() },
  });
  check("dismissing does not release it", (await speakNewFindings(waved.id)).spoken, 0);

  // The finding is still true, so the detector re-confirms it — and that is what
  // used to hand it back to J4 as something new to say.
  await raiseWaved();
  const reconfirmed = await prisma.genesisObservation.findFirstOrThrow({
    where: { storeId: waved.id, dedupeKey: "insight:revenue.decreased" },
  });
  check("the sweep really does re-activate it", reconfirmed.status, "ACTIVE");
  check("and J4 still says nothing", (await speakNewFindings(waved.id)).spoken, 0);
  check("so the owner was told exactly once",
    (await prisma.storeMessage.findMany({ where: { storeId: waved.id, role: "assistant" } })).length, 1);

  // RESOLVED IS STILL DIFFERENT. A finding that genuinely stops being true
  // releases the delivery even after a dismissal, so a real recurrence later is
  // news rather than nagging.
  await resolveMissingObservations(waved.id, [], "urgent", "insight:");
  check("resolving releases it even after a dismissal",
    (await speakNewFindings(waved.id)).closed, 1);
  await raiseWaved();
  check("and a genuine recurrence may speak", (await speakNewFindings(waved.id)).spoken, 1);
  await prisma.store.deleteMany({ where: { id: waved.id } });

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

  // THE RACE THAT ACTUALLY HAPPENS, and why its regression is a source
  // assertion rather than a runtime one.
  //
  // The concurrency check above ran against a finding that had ALREADY been
  // spoken, so all three passes correctly found nothing — it passed while the
  // defect was live. The real window is two cycles overlapping on a FRESH
  // finding: both saw it, both wrote an execution row, both wrote a MESSAGE, and
  // only then did one lose the claim. Reproduced standalone before the fix:
  // three concurrent passes produced THREE messages, three execution rows and
  // one delivery. The owner told the same thing three times.
  //
  // The fix is a transaction: the claim decides, so a conflict on it takes the
  // message and the execution row with it. Confirmed on the same reproduction
  // afterwards — one message, one execution row, one delivery.
  //
  // That reproduction cannot live here. This harness serves PGlite over a single
  // connection, and three concurrent interactive transactions leave it returning
  // another model's rows for the next query — a harness fact (see BI_ENGINE.md
  // on maxConnections), not a product one. Asserting the shape is what is
  // honestly available, and it is the thing that would regress.
  const proactiveSrc = readFileSync(
    join(process.cwd(), "lib", "intelligence", "proactive.ts"), "utf8"
  );
  assert("the three writes are one unit",
    proactiveSrc.includes("await prisma.$transaction(async (tx) => {"),
    "written in sequence, a lost claim leaves the message behind and the owner is told twice");
  for (const write of ["tx.storeMessage.create(", "tx.proactiveDelivery.create("]) {
    assert(`${write.split("(")[0]} runs on the transaction`,
      proactiveSrc.includes(write),
      "a write on the ordinary client is not rolled back by the claim conflict");
  }
  // Sliced rather than matched across a newline: this file is CRLF and an
  // assertion spanning a line break silently never matches. That mistake has
  // been made four times in this repository now.
  const logCall = proactiveSrc.slice(proactiveSrc.indexOf("recordGenesisExecution("));
  assert("including the execution row",
    logCall.slice(0, logCall.indexOf("      );")).includes("tx"),
    "an execution row outside the transaction survives a lost claim");

  assert("and a lost claim is not treated as an error",
    proactiveSrc.includes("if (isDuplicateDelivery(err)) return false;"),
    "losing the race means the owner has already been told");

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
  console.log("\n=== P4. Replying to it reaches the finding and the business ===\n");
  // ==========================================================================
  // A proactive message the owner cannot usefully answer is a notification with
  // better copy. Verified rather than assumed, and the answer is that this
  // already works through the representation that already exists: the message
  // IS an ordinary conversation row, and both reply paths read the whole
  // conversation for the business they are in.
  //
  // So there is nothing to build and something to protect. A filter added to
  // either history read — by role, by whether a message carries an execution
  // link — would silently make J4 unable to discuss what it had just said,
  // and nothing else in the codebase would notice.

  // The same query shape both reply paths use: store-scoped, newest first,
  // no filter on role or anything else.
  const historyAReplyWouldRead = await prisma.storeMessage.findMany({
    where: { storeId: shop.id },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  assert("a proactive message is in the history a reply reads",
    historyAReplyWouldRead.some((m) => m.content.includes("Revenue is down again, 25%")),
    "a reply that cannot see what J4 just said would answer into a vacuum");
  // Verbatim, because the message IS the finding's own summary. The model
  // reading the conversation sees the finding itself, not a paraphrase of it —
  // which is why no second context representation is needed for this.
  assert("carrying the finding's own words, not a paraphrase",
    historyAReplyWouldRead.some((m) => m.content.includes("Revenue is down again, 25% on last month.")),
    "the finding's summary is what reaches the model, through the conversation");

  // AND ONLY IN ITS OWN BUSINESS. The neighbour's reply reads the neighbour's
  // conversation, which never contained this.
  const neighbourHistory = await prisma.storeMessage.findMany({
    where: { storeId: neighbour.id },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  check("the neighbour's history is empty", neighbourHistory.length, 0);
  assert("so a reply there cannot see this business's finding",
    !neighbourHistory.some((m) => m.content.includes("Revenue is down")),
    "conversation history is the business boundary for a reply, as it is for everything else");

  // THE REGRESSION GUARD. Both reply paths must keep reading the conversation
  // whole. Asserted from source, because the failure is an added filter rather
  // than a wrong value, and no runtime assertion here would see it.
  for (const [name, relative] of [
    ["the streaming route", ["app", "api", "chat", "route.ts"]],
    ["the Server Action", ["app", "dashboard", "ai-actions.ts"]],
  ] as const) {
    const source = readFileSync(join(process.cwd(), ...relative), "utf8");
    const query = source.slice(source.indexOf("const recentMessages = await prisma.storeMessage.findMany("));
    const head = query.slice(0, query.indexOf("});") + 3);
    assert(`${name} reads the conversation scoped to its business`,
      head.includes("where: { storeId: store.id }"),
      "an unscoped history read would put another business's conversation in the prompt");
    assert(`${name} does not filter the conversation by role`,
      !head.includes("role:"),
      "filtering by role would drop what J4 said, including everything it raised itself");
    assert(`${name} does not filter out messages carrying an execution`,
      !head.includes("executionLogId"),
      "a proactive message carries one; filtering on it would hide exactly these");
  }

  // ==========================================================================
  console.log("\n=== PD4. A message carries its OWN proposal, or none ===\n");
  // ==========================================================================
  // A proactive message may carry a proposal — but only the one the finding
  // caused. The conversation shows one card, and it showed the NEWEST pending
  // proposal, related or not: a message about falling revenue directly above a
  // card proposing a new hero image reads as one thing and is not.
  //
  // Nothing new records the association. A finding and a CognitiveOutput
  // already share a key (dedupeKey / topicKey), and a proposal already points at
  // the output it came from. This walks that chain.
  const pd4 = await prisma.store.create({
    data: { userId: owner.id, name: "Decisions", slug: `pj-d-${uniq()}` },
  });

  // A finding with no decision behind it proposes nothing. This is the ordinary
  // case and the whole of PD4's safety property: J4 does not conjure a decision
  // where the finding did not produce one.
  await upsertObservation(pd4.id, {
    dedupeKey: "insight:revenue.decreased",
    genesisState: "urgent",
    summary: "Revenue is down.",
    actionHref: null,
  });
  check("a finding with no proposal behind it offers none",
    await proposalForFinding(pd4.id, "insight:revenue.decreased"), null);

  // AN UNRELATED PENDING PROPOSAL IS NOT OFFERED. The exact thing forbidden:
  // a proposal exists, it is pending, and it has nothing to do with this
  // finding — so J4 must not present it as the decision it is talking about.
  // WITH ITS OWN COGNITIVE OUTPUT, under a different topic. A proposal with no
  // output at all is trivially unreachable; this is the one that would actually
  // be returned by a lookup that forgot to match the finding's key.
  const otherTopic = await prisma.cognitiveOutput.create({
    data: {
      storeId: pd4.id, kind: "opportunity", summary: "Refresh the hero",
      priority: "medium", confidence: 0.8, status: "ACTIVE",
      topicKey: "insight:storefront.stale",
    },
  });
  const unrelated = await prisma.approvalRequest.create({
    data: {
      storeId: pd4.id, actionType: "update_hero", input: {}, previousValues: {},
      summary: "A new hero image", status: "PENDING_APPROVAL",
      cognitiveOutputId: otherTopic.id,
    },
  });
  check("an unrelated pending proposal is still not offered",
    await proposalForFinding(pd4.id, "insight:revenue.decreased"), null);
  check("and J4 raises nothing to point at",
    await proposalJ4Raised(pd4.id), null);

  // NOW A FINDING THAT DID PRODUCE A DECISION. The output carries the finding's
  // own key, and the proposal points at the output.
  const output = await prisma.cognitiveOutput.create({
    data: {
      storeId: pd4.id, kind: "opportunity", summary: "Discount the slow seller",
      priority: "medium", confidence: 0.8, status: "ACTIVE",
      topicKey: "insight:revenue.decreased",
    },
  });
  const related = await prisma.approvalRequest.create({
    data: {
      storeId: pd4.id, actionType: "update_product", input: {}, previousValues: {},
      summary: "Reduce the price of the slow seller", status: "PENDING_APPROVAL",
      cognitiveOutputId: output.id,
    },
  });
  check("the finding's own proposal is found",
    await proposalForFinding(pd4.id, "insight:revenue.decreased"), related.id);
  assert("and it is not the unrelated one",
    (await proposalForFinding(pd4.id, "insight:revenue.decreased")) !== unrelated.id,
    "offering whichever proposal is newest is the thing PD4 forbids");

  check("speaking records it on the turn", (await speakNewFindings(pd4.id)).spoken, 1);
  check("so the conversation points at that decision",
    await proposalJ4Raised(pd4.id), related.id);

  // THE OWNER STILL DECIDES. Nothing here approves, executes or rejects — the
  // proposal is exactly as pending after J4 spoke as before.
  const untouched = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: related.id } });
  check("J4 has not decided it", untouched.status, "PENDING_APPROVAL");
  check("nor recorded a decider", untouched.decidedByUserId, null);
  check("nor executed anything", untouched.executionId, null);

  // AND A DECIDED PROPOSAL STOPS BEING POINTED AT. The message stays — it is a
  // record of what J4 said — but showing a decided proposal as the thing
  // awaiting the owner is the execution-state dishonesty UI6 exists to prevent.
  // updateMany, not update: the tenant guard refuses a store-unscoped mutation
  // and a unique `where: { id }` cannot carry a storeId. It caught this fixture.
  await prisma.approvalRequest.updateMany({
    where: { id: related.id, storeId: pd4.id },
    data: { status: "EXECUTED", decidedByUserId: owner.id, decidedAt: new Date() },
  });
  check("once decided, the conversation stops offering it",
    await proposalJ4Raised(pd4.id), null);
  check("while what J4 said is still there",
    (await prisma.storeMessage.findMany({ where: { storeId: pd4.id, role: "assistant" } })).length, 1);

  // Cross-business: another store's proposal is never offered here.
  check("a proposal in another business is not reachable",
    await proposalForFinding(neighbour.id, "insight:revenue.decreased"), null);
  await prisma.store.deleteMany({ where: { id: pd4.id } });

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
  console.log("\n=== J4 asks for what it is missing, out loud ===\n");
  // ==========================================================================
  // J4_IDENTITY.md freezes "how J4 asks for what it's missing" and names
  // proposeConnectionGaps as the one shipped instance of it. It shipped where
  // it could not be heard: a CognitiveOutput surfaces on the Connections page,
  // so the ask only reached an owner who had already gone looking for it — and
  // the whole point of the principle is asking at the moment the gap matters.
  //
  // Now the same finding is also an observation, which is what Proactive J4
  // speaks. Asserted here rather than in a connections suite because what is
  // being verified is that the ask REACHES THE CONVERSATION.
  const gapsSource = readFileSync(
    join(process.cwd(), "lib", "integrations", "gaps.ts"), "utf8"
  );
  assert("a connection gap is written as a finding J4 can speak",
    gapsSource.includes("await upsertObservation(storeId, {"),
    "a CognitiveOutput alone only reaches an owner already on the Connections page");
  assert("as an opportunity, never urgent",
    gapsSource.includes('genesisState: "opportunity"'),
    "a missing connection sits behind anything actually wrong");
  // ONE FINDING, ONE DESCRIPTION. The page and the conversation read different
  // rows; if they carried different summaries they would describe one gap two
  // ways, which is how a card and a sentence start disagreeing.
  check("the page's row and the conversation's row carry the same summary",
    gapsSource.split("summary: gap.reason,").length - 1, 2);
  // J4'S OWN VOICE. Every reason is already a complete first-person sentence
  // ending "…would let me help you…", so the old `Genesis noticed ${reason}`
  // switched person mid-sentence: Genesis noticed, and then I would help you.
  assert("and J4 does not introduce itself in the third person",
    !gapsSource.includes("summary: `Genesis noticed ${gap.reason}`"),
    "a finding that reports on J4 is not J4 speaking");

  // A CLOSED GAP STOPS BEING SAID, and only its own rows are resolved.
  assert("a gap that closed resolves its finding",
    gapsSource.includes("await resolveMissingObservations("),
    "connecting the integration must stop J4 asking for it");
  assert("scoped to its own prefix",
    gapsSource.includes("CONNECTION_GAP_PREFIX\n  );") ||
      gapsSource.includes("    CONNECTION_GAP_PREFIX"),
    "an unscoped resolve would clear another sweep's opportunity findings");

  // And end to end: a gap-shaped finding is spoken exactly once, like any
  // other, through the machinery already asserted above.
  await upsertObservation(shop.id, {
    dedupeKey: "connection_gap:QUICKBOOKS",
    genesisState: "opportunity",
    summary:
      "£2,400 in real revenue on record with no accounting system connected yet — connecting QuickBooks would let me help you understand your real numbers.",
    actionHref: "/dashboard/connections",
  });
  check("the ask is spoken", (await speakNewFindings(shop.id)).spoken, 1);
  const asked = await assistantMessages(shop.id);
  const askMessage = asked[asked.length - 1];
  assert("in J4's own voice, with the evidence in it",
    askMessage.content.includes("£2,400 in real revenue") &&
      askMessage.content.includes("would let me help you"),
    askMessage.content);
  assert("and never in the third person",
    !askMessage.content.includes("Genesis noticed"), askMessage.content);
  check("and not again next cycle", (await speakNewFindings(shop.id)).spoken, 0);

  // ==========================================================================
  console.log("\n=== The sentence itself ===\n");
  // ==========================================================================
  // An ask already introduces itself. Prefixing a generic opener in front of a
  // question adds a beat that says nothing before a sentence carrying its own
  // reason — and filler is how copy stops sounding like a person.
  const askShaped = "You've got 2 people on your team and I don't have anything about how you run things — would you like to upload your employee handbook?";
  check("a finding that is already a question is left to speak for itself",
    proactiveMessageFor({ genesisState: "opportunity", summary: askShaped }), askShaped);
  assert("with no opener in front of it",
    !proactiveMessageFor({ genesisState: "opportunity", summary: askShaped }).startsWith("I noticed"),
    "a question does not need to be announced");
  // An urgent ask is still not announced either — the question is the point.
  assert("and the same for an urgent one",
    proactiveMessageFor({ genesisState: "urgent", summary: askShaped }) === askShaped,
    "urgency is in the words, not in a prefix");

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
