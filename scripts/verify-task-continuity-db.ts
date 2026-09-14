import "@/scripts/lib/allowServerOnly";
import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prismaSystem } from "@/lib/prisma";
import { relevantTaskFor, describeRelevantTask } from "@/lib/j4/relevantTask";

// J4 KNOWS WHAT THE OWNER WAS WORKING TOWARD, AFTER THE MESSAGES ARE GONE:
//
//   npx tsx scripts/run-db-suites.ts task-continuity
//
// ============ THE CONTRACT (2026-09-14) ================================
//
// Task is the durable record of multi-step work. The only thing that ever put
// it in front of J4 was the seed turn startTaskConversation writes — an
// ordinary message, read back out of a 50-message window. Past fifty turns it
// fell out of the prompt and J4 silently stopped knowing, while Task.status
// still read IN_PROGRESS.
//
// The relevance rule, and nothing else decides it:
//
//   1. Conversation.taskId — the owner opened this conversation about a task.
//   2. A StoreMessage in this same bucket carries taskId.
//   3. Anything else is SILENCE. Zero matches, two matches, a finished task:
//      all null. Recency is never proof.
//
// THE FIFTY-MESSAGE TEST IS THE ONE THAT MATTERS. Section 2 buries the seed
// turn under sixty later messages — further back than any prompt window
// reaches — and asserts J4 is still told what the work is. Deleting the durable
// read makes exactly that assertion fail, which is the sabotage below.

let failures = 0;
let passes = 0;
const failed: string[] = [];

function assert(label: string, ok: boolean, detail = ""): void {
  if (ok) passes++;
  else {
    failures++;
    failed.push(`${label}${detail ? `  — ${detail}` : ""}`);
  }
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail ? `  — ${detail}` : ""}`);
}

async function main(): Promise<void> {
  await requireTestDatabase(prismaSystem);
  const stamp = Date.now();
  const user = await prismaSystem.user.create({ data: { email: `tc-${stamp}@example.test` } });
  const store = await prismaSystem.store.create({
    data: { userId: user.id, name: "Copper Works", slug: `tc-${stamp}`, currency: "USD" },
  });

  const makeTask = (tag: string, status: string, extra: Record<string, unknown> = {}) =>
    prismaSystem.task.create({
      data: {
        storeId: store.id,
        dedupeKey: `tc:${tag}:${stamp}`,
        source: "manual",
        title: `Set up ${tag}`,
        summary: `The half-finished ${tag} work.`,
        context: {},
        priority: "opportunity",
        status,
        ...extra,
      },
    });

  const say = (content: string, taskId: string | null, conversationId: string | null = null) =>
    prismaSystem.storeMessage.create({
      data: { storeId: store.id, role: "assistant", content, taskId, conversationId },
    });

  // ==================================================================
  console.log("\n1. Nothing under way — J4 volunteers nothing\n");
  // ==================================================================
  {
    const none = await relevantTaskFor({ storeId: store.id, conversationId: null });
    assert("no task, no line", none === null, JSON.stringify(none));
    assert("  and nothing is rendered", describeRelevantTask(none) === null);
  }

  // ==================================================================
  console.log("\n2. THE FIFTY-MESSAGE CLIFF — the seed turn is long gone\n");
  // ==================================================================
  //
  // This is the failure the whole change exists for. The seed turn is written
  // first, then buried under sixty later messages — beyond any window a prompt
  // carries. The Task row is unchanged, so J4 must still know.
  const shipping = await makeTask("shipping", "IN_PROGRESS");
  {
    await say("Let's set up your shipping.", shipping.id);
    for (let i = 0; i < 60; i++) await say(`Unrelated turn ${i}.`, null);

    const found = await relevantTaskFor({ storeId: store.id, conversationId: null });
    assert("J4 still knows the work after 60 later messages", found?.id === shipping.id,
      found ? found.title : "(nothing)");
    const line = describeRelevantTask(found);
    assert("  and is told what it is, in the owner's words",
      !!line && line.includes("Set up shipping") && line.includes("half-finished"), line ?? "(none)");
    assert("  and told to continue rather than restart",
      !!line && /continue it rather than starting over/i.test(line), line ?? "(none)");
    // THE INTERNAL ID NEVER REACHES THE PROMPT — the same rule
    // verify-j4-selection holds for record ids.
    assert("  without handing J4 an id it cannot speak",
      !!line && !line.includes(shipping.id), line ?? "(none)");
  }

  // ==================================================================
  console.log("\n3. Two tasks in one thread — J4 does not guess\n");
  // ==================================================================
  {
    const pricing = await makeTask("pricing", "IN_PROGRESS");
    await say("And let's look at pricing.", pricing.id);

    const ambiguous = await relevantTaskFor({ storeId: store.id, conversationId: null });
    assert("two plausible tasks means silence", ambiguous === null,
      ambiguous ? `picked ${ambiguous.title}` : "");
    // AND NOT BY RECENCY. Pricing is the newer of the two and is still not
    // chosen — there is deliberately no most-recent fallback.
    assert("  and the newer one is not chosen either",
      ambiguous === null, ambiguous ? ambiguous.title : "");

    await prismaSystem.task.update({
      where: { id: pricing.id },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
    // Still two DISTINCT taskIds in the thread, so still ambiguous. Finishing
    // one does not retroactively make the other the subject.
    const after = await relevantTaskFor({ storeId: store.id, conversationId: null });
    assert("  finishing one does not resolve the ambiguity", after === null,
      after ? after.title : "");
  }

  // ==================================================================
  console.log("\n4. Buckets stay separate, and identity survives\n");
  // ==================================================================
  {
    const conversation = await prismaSystem.conversation.create({
      data: { storeId: store.id, name: "Packaging" },
    });
    // A DIFFERENT THREAD. The ungrouped history is ambiguous (section 3), and
    // this conversation must not inherit that — nor anything else's task.
    const inBucket = await relevantTaskFor({ storeId: store.id, conversationId: conversation.id });
    assert("a fresh conversation inherits nothing", inBucket === null,
      inBucket ? inBucket.title : "");

    const labels = await makeTask("labels", "IN_PROGRESS");
    await say("Labels, then.", labels.id, conversation.id);
    const now = await relevantTaskFor({ storeId: store.id, conversationId: conversation.id });
    assert("  its own linked task is found", now?.id === labels.id, now ? now.title : "(nothing)");

    // AND THE CONVERSATION ITSELF CAN NAME ONE. Conversation.taskId is the
    // first signal and outranks the thread scan.
    const owned = await prismaSystem.conversation.create({
      data: { storeId: store.id, name: "Shipping again", taskId: shipping.id },
    });
    const byConversation = await relevantTaskFor({ storeId: store.id, conversationId: owned.id });
    assert("a conversation opened about a task names it", byConversation?.id === shipping.id,
      byConversation ? byConversation.title : "(nothing)");

    // ANOTHER BUSINESS'S CONVERSATION IS NOT THIS ONE'S.
    const otherUser = await prismaSystem.user.create({ data: { email: `tc2-${stamp}@example.test` } });
    const otherStore = await prismaSystem.store.create({
      data: { userId: otherUser.id, name: "Elsewhere", slug: `tc2-${stamp}`, currency: "USD" },
    });
    const foreign = await relevantTaskFor({ storeId: otherStore.id, conversationId: owned.id });
    assert("  and another business cannot read it", foreign === null,
      foreign ? foreign.title : "");
  }

  // ==================================================================
  console.log("\n5. A task waiting on the owner says so\n");
  // ==================================================================
  {
    const conversation = await prismaSystem.conversation.create({
      data: { storeId: store.id, name: "Costs" },
    });
    const costs = await makeTask("costs", "AWAITING_INPUT", {
      requiredInput: { question: "What does a unit cost in bulk?" },
    });
    await say("What does a unit cost you?", costs.id, conversation.id);

    const found = await relevantTaskFor({ storeId: store.id, conversationId: conversation.id });
    assert("an AWAITING_INPUT task is surfaced", found?.id === costs.id, found ? found.title : "(nothing)");
    const line = describeRelevantTask(found);
    assert("  and J4 is told not to act until they answer",
      !!line && /waiting on the owner/i.test(line), line ?? "(none)");
  }

  // ==================================================================
  console.log("\n6. Finished work is not resumable\n");
  // ==================================================================
  {
    const conversation = await prismaSystem.conversation.create({
      data: { storeId: store.id, name: "Done thing" },
    });
    const done = await makeTask("done", "COMPLETED", { completedAt: new Date() });
    await say("That one is finished.", done.id, conversation.id);
    const found = await relevantTaskFor({ storeId: store.id, conversationId: conversation.id });
    assert("a COMPLETED task is never offered as in progress", found === null,
      found ? found.title : "");

    // AND A CONVERSATION POINTING AT A FINISHED TASK IS HISTORY, NOT WORK.
    const old = await prismaSystem.conversation.create({
      data: { storeId: store.id, name: "Old", taskId: done.id },
    });
    const viaConversation = await relevantTaskFor({ storeId: store.id, conversationId: old.id });
    assert("  even when the conversation names it", viaConversation === null,
      viaConversation ? viaConversation.title : "");
  }

  console.log(`\n${failures} failed, ${passes} passed`);
  if (failures > 0) {
    console.log("\nFAILED:");
    for (const line of failed) console.log(`  ${line}`);
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prismaSystem.$disconnect();
  });
