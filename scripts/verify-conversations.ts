import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";

// CONVERSATIONS (UI6 piece 2):
//
//   npx tsx scripts/verify-conversations.ts
//
// BRINGS ITS OWN POSTGRES, and therefore is NOT in the shared runner — the same
// arrangement verify-insights-live.ts and verify-proposals-live.ts use, for the
// same reason. This suite drives buildTurnContext, which fans out parallel reads
// through getBusinessUnderstanding; on the shared harness, PGlite serves one
// connection and that left an unrelated suite three positions later dying with
// "Connection terminated unexpectedly". A suite that breaks a different suite is
// not a passing suite.
//
// Worth stating plainly because I learned it the hard way one milestone ago: a
// suite outside the shared runner is one somebody has to remember to run, and a
// green "42/42" does not include it.
//
// A conversation is an explicit, persistent thread. The centre of this suite is
// the resumption invariant, because it is the one thing that could quietly stop
// being true as soon as somebody decides history "should" be reproducible:
//
//   Conversation history is a record of what was said, not a frozen snapshot of
//   what was known.

let failures = 0;
const results: { name: string; ok: boolean }[] = [];

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ name, ok });
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}
function assert(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok });
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const uniq = () => Math.random().toString(36).slice(2, 10);
const chr10 = String.fromCharCode(10);

async function main() {
  const db = await startRealPostgres();
  await db.prisma.$disconnect();

  process.env[TEST_DATABASE_ENV] = "1";
  process.env.DATABASE_URL = db.url;

  // Imported after the database is pointed at, so the client binds to it.
  const { prisma } = await import("@/lib/prisma");
  const { createConversation, listConversations, conversationInBusiness, conversationMessages } =
    await import("@/lib/j4/conversations");
  const { persistToolTurn } = await import("@/lib/dashboard/runToolTurn");
  const { buildTurnContext } = await import("@/lib/dashboard/chatTurnContext");

  const owner = await prisma.user.create({ data: { email: `cv-${uniq()}@test.local` } });
  const shop = await prisma.store.create({
    data: { userId: owner.id, name: "Copper & Coil", slug: `cv-${uniq()}` },
  });
  const neighbour = await prisma.store.create({
    data: { userId: owner.id, name: "Iron Gym", slug: `cv-n-${uniq()}` },
  });

  // ==========================================================================
  console.log("\n=== 1. Explicit creation, optional owner name ===\n");
  // ==========================================================================
  const unnamed = await createConversation({ storeId: shop.id });
  const named = await createConversation({ storeId: shop.id, name: "  The ring launch  " });
  const rows = await listConversations(shop.id);
  check("both exist", rows.length, 2);
  check("a name is the owner's words, trimmed",
    rows.find((r) => r.id === named.id)?.name, "The ring launch");
  check("and no name is null, not an empty name",
    rows.find((r) => r.id === unnamed.id)?.name, null);
  // "Named nothing" and "unnamed" are the same thing to a reader.
  const blank = await createConversation({ storeId: shop.id, name: "   " });
  check("whitespace is not a name",
    (await listConversations(shop.id)).find((r) => r.id === blank.id)?.name, null);

  // NOTHING GENERATES A NAME. Asserted from source, because the failure would be
  // a new dependency on a model credential rather than a wrong value.
  const { readFileSync } = await import("fs");
  const { join } = await import("path");
  const src = readFileSync(join(process.cwd(), "lib", "j4", "conversations.ts"), "utf8");
  assert("nothing in this module reaches a model",
    !/callGenesisModel|anthropic|generateName/i.test(src),
    "a J4-titled thread would make this milestone depend on a credential");
  // THE MODEL, not this module's prose. A first version of this assertion read
  // the source of conversations.ts and failed on its own comment explaining that
  // a closedAt column is not a reason to build closing — the same
  // comment-matching trap that has now bitten three assertions in this
  // repository. What actually matters is that the column does not exist.
  const schema = readFileSync(join(process.cwd(), "prisma", "schema.prisma"), "utf8");
  const model = schema.slice(schema.indexOf("model Conversation {"));
  const modelBody = model.slice(0, model.indexOf(chr10 + "}"));
  assert("the model has no closing or archiving field",
    !/closedAt|archivedAt|closedBy/.test(modelBody), modelBody.slice(0, 200));
  assert("and no generated-title field",
    !/generatedName|autoTitle|titleGeneratedAt/.test(modelBody), "nothing generates a name");

  // ==========================================================================
  console.log("\n=== 2. THE RESUMPTION INVARIANT ===\n");
  // ==========================================================================
  // 1. create a conversation  2. send a message  3. change a business fact
  // 4. resume  5. the resumed turn sees the NEW fact  6. history is unrewritten.
  const thread = await createConversation({ storeId: shop.id, name: "Pricing" });

  await persistToolTurn({
    storeId: shop.id,
    userId: owner.id,
    userMessage: "What should I charge for the rings?",
    userMessageChanges: null,
    writeUserMessage: true,
    conversationId: thread.id,
    results: [{ handled: true, reply: "Let's look at your costs.", kind: "data_question" }],
  });

  const beforeCount = (await conversationMessages(shop.id, thread.id)).length;
  check("the turn landed in the conversation", beforeCount, 2);
  const historyBefore = (await conversationMessages(shop.id, thread.id)).map((m) => m.content);

  // THE FACT ARRIVES AFTER THE CONVERSATION'S LAST MESSAGE.
  await prisma.businessRecord.create({
    data: {
      storeId: shop.id, entityType: "goal", sourceProvider: "owner", externalId: `goal-${uniq()}`,
      data: {
        description: "Double ring revenue by Christmas",
        category: "revenue",
        status: "active",
        priority: "high",
        targetDate: null,
        identifiedAt: new Date().toISOString(),
        relatedChallengeIds: [],
      },
    },
  });

  // RESUME. buildTurnContext is what a real turn calls, so this is the real path.
  const resumed = await buildTurnContext({
    storeId: shop.id,
    userId: owner.id,
    userMessage: "Right, so what do you think?",
    activeProductNames: "none",
  });
  const rendered = resumed.parts.join("\n");
  assert("the resumed turn is given the fact learned AFTER the last message",
    rendered.includes("Double ring revenue by Christmas"),
    "history is a record of what was said, not a snapshot of what was known");

  // AND THE MESSAGES THEMSELVES ARE UNTOUCHED.
  const historyAfter = (await conversationMessages(shop.id, thread.id)).map((m) => m.content);
  check("no historical message was rewritten", historyAfter, historyBefore);
  check("and none was added by resuming", historyAfter.length, beforeCount);

  // Appending continues the same conversation rather than starting one.
  await persistToolTurn({
    storeId: shop.id,
    userId: owner.id,
    userMessage: "Right, so what do you think?",
    userMessageChanges: null,
    writeUserMessage: true,
    conversationId: thread.id,
    results: [{ handled: true, reply: "Aim higher on the rings.", kind: "data_question" }],
  });
  check("the reply appended to the same conversation",
    (await conversationMessages(shop.id, thread.id)).length, 4);
  check("and no new conversation appeared",
    (await listConversations(shop.id)).length, 4);

  // ==========================================================================
  console.log("\n=== 3. The anchor is context, never identity ===\n");
  // ==========================================================================
  const task = await prisma.task.create({
    data: {
      storeId: shop.id,
      dedupeKey: `task-${uniq()}`,
      source: "manual",
      title: "Photograph the rings",
      summary: "The rings need real photos.",
      context: {},
      priority: "opportunity",
    },
  });
  const anchored = await createConversation({ storeId: shop.id, name: "Photos", taskId: task.id });
  await persistToolTurn({
    storeId: shop.id, userId: owner.id, userMessage: "About the photos",
    userMessageChanges: null, writeUserMessage: true, conversationId: anchored.id,
    results: [{ handled: true, reply: "Noted.", kind: "data_question" }],
  });
  check("the anchored conversation holds its turn",
    (await conversationMessages(shop.id, anchored.id)).length, 2);

  // DELETING THE TASK MUST NOT DELETE THE CONVERSATION. SetNull, not Cascade —
  // the difference between an anchor and an owner.
  await prisma.task.deleteMany({ where: { id: task.id, storeId: shop.id } });
  const survivor = await prisma.conversation.findUnique({ where: { id: anchored.id } });
  assert("the conversation survives its task", survivor !== null,
    "an anchor is optional metadata; identity is the row");
  check("with the anchor cleared rather than dangling", survivor?.taskId, null);
  check("and every message still in it",
    (await conversationMessages(shop.id, anchored.id)).length, 2);

  // ==========================================================================
  console.log("\n=== 4. No backfill, ever ===\n");
  // ==========================================================================
  // History from before conversations existed keeps a null. That is what "no
  // conversation was recorded" looks like, and it is not the same as belonging
  // to a manufactured one.
  const historic = await prisma.storeMessage.create({
    data: { storeId: shop.id, role: "user", content: "Something said last month" },
  });
  check("an older message has no conversation", historic.conversationId, null);
  await listConversations(shop.id);
  await conversationMessages(shop.id, thread.id);
  const stillNull = await prisma.storeMessage.findUniqueOrThrow({ where: { id: historic.id } });
  check("and reading conversations does not assign it one", stillNull.conversationId, null);
  assert("nor does it appear inside one",
    !(await conversationMessages(shop.id, thread.id)).some((m) => m.id === historic.id),
    "a null conversation is read by the ordinary store-wide history, not by a thread");

  // ==========================================================================
  console.log("\n=== 5. One business's conversations are its own ===\n");
  // ==========================================================================
  check("the neighbour has none", (await listConversations(neighbour.id)).length, 0);
  check("and cannot claim this store's",
    await conversationInBusiness(neighbour.id, thread.id), null);
  check("while this store can", await conversationInBusiness(shop.id, thread.id), thread.id);
  check("a conversation that does not exist is not in any business",
    await conversationInBusiness(shop.id, "no-such-conversation"), null);
  check("and the neighbour reads no messages from it",
    (await conversationMessages(neighbour.id, thread.id)).length, 0);

  // ==========================================================================
  console.log("\n=== 6. The owner-facing surface ===\n");
  // ==========================================================================
  // A conversation is not a feature if the owner cannot start one, see the ones
  // they have, or return to one. This is the rest of piece 2, not piece 1.

  // WHAT THE PICKER IS GIVEN. listConversations is what the surface reads, so
  // the counts and last-message times it shows are asserted here rather than
  // trusted to a component.
  const listed = await listConversations(shop.id);
  const pricing = listed.find((c) => c.id === thread.id);
  check("a conversation reports how much was said in it", pricing?.messageCount, 4);
  assert("and when it was last spoken in", pricing?.lastMessageAt !== null, "needed to order or label it");
  const empty = listed.find((c) => c.id === unnamed.id);
  check("a conversation nobody has used yet reports zero", empty?.messageCount, 0);
  check("and has no last message", empty?.lastMessageAt, null);

  // NEWEST FIRST, so the picker's order is the surface's and not the client's.
  const times = listed.map((c) => c.createdAt.getTime());
  assert("the list is newest first",
    times.every((t, i) => i === 0 || times[i - 1] >= t), JSON.stringify(times));

  // THE REQUEST PATH'S GUARD. A conversation id arrives in a POST body, so an
  // unchecked one would write a turn into another business's thread — the
  // defect class UI6's first half removed, arriving through a new door.
  const routeSrc = readFileSync(join(process.cwd(), "app", "api", "chat", "route.ts"), "utf8");
  assert("the route checks the conversation belongs to this business",
    routeSrc.includes("await conversationInBusiness(store.id, requestedConversationId)"),
    "an id from a request body is not evidence it belongs here");
  assert("and reads that conversation's own history",
    routeSrc.includes("where: { storeId: store.id, conversationId },"),
    "reading the whole store would put another conversation's exchange in the prompt");
  assert("still scoped to the business, never only to the conversation",
    !routeSrc.includes("where: { conversationId },"),
    "conversationId narrows within a business; it never replaces the business filter");

  // CREATION HAS EXACTLY ONE DOOR, and the turn path is not it.
  const turnSrc = readFileSync(join(process.cwd(), "lib", "dashboard", "runToolTurn.ts"), "utf8");
  assert("no turn creates a conversation",
    !/conversation\.create|createConversation/.test(turnSrc),
    "explicit means a conversation cannot appear as a side effect of sending a message");
  const actionSrc = readFileSync(join(process.cwd(), "app", "j4", "conversation-actions.ts"), "utf8");
  assert("the one that does resolves its business from the surface",
    actionSrc.includes("requireBusinessOrActive(PERMISSIONS.GENESIS_CHAT, slug)"),
    "a new write path must not read the account's active pointer");

  // THE PICKER OFFERS NOTHING THE CONTRACT REFUSED. No rename, no close, no
  // archive, no delete — and the check is on the component, where such a
  // control would have to live.
  const pickerSrc = readFileSync(join(process.cwd(), "app", "j4", "ConversationPicker.tsx"), "utf8");
  for (const absent of ["Rename", "Archive", "Delete", "Close conversation"]) {
    assert(`the picker offers no "${absent}"`,
      !pickerSrc.includes(absent), "v1 has no such behaviour");
  }
  assert("and nothing in it generates a name",
    !/callGenesisModel|generateName|autoTitle/i.test(pickerSrc),
    "a name is the owner's or it is null");

  await prisma.$disconnect();
  await db.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? `ALL PASS (${results.length})` : `${failed.length} of ${results.length} FAILED`}`);
  if (failed.length) console.log(failed.map((f) => `  - ${f.name}`).join("\n"));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
