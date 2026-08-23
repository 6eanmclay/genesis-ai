import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { persistToolTurn } from "@/lib/dashboard/runToolTurn";
import {
  messageStateOf,
  MESSAGE_STATE_LABEL,
  needsOwner,
  type MessageState,
} from "@/lib/j4/messageState";

// WHAT THE CONVERSATION SAYS HAPPENED vs WHAT HAPPENED:
//
//   npx tsx scripts/run-db-suites.ts message-state
//
// UI6. The conversation rendered prose and nothing else, so a question
// answered, a change waiting for a decision, and a change that failed and can
// be retried were the same grey paragraph — the owner had to read J4's own
// sentence and believe it.
//
// The prose is written at the moment J4 speaks and never revised. The execution
// row written in the same breath is what actually happened. This suite holds
// the one rule that matters: when they disagree, the row wins, and nothing here
// reads the words at all.

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

async function main() {
  await requireTestDatabase(prismaSystem);

  // ==========================================================================
  console.log("\n=== 1. A missing execution row is not a success ===\n");
  // ==========================================================================
  // MOST MESSAGES HAVE NONE — every ordinary reply, the merchant's own words,
  // and the entire history written before this join existed. Defaulting them to
  // "done" would decorate all of it with a claim nothing supports.
  check("no row at all is only 'spoken'", messageStateOf(null), "spoken");
  check("and 'spoken' shows no badge", MESSAGE_STATE_LABEL.spoken, null);
  // An unrecognised status must not fall through to success either, or any
  // future ExecutionStatus silently reads as a completed change.
  check("an unknown status is not a success",
    messageStateOf({ status: "SOMETHING_NEW", retryable: false, kind: null }), "spoken");

  // ==========================================================================
  console.log("\n=== 2. The states the owner actually needs apart ===\n");
  // ==========================================================================
  check("a data question reads as answered",
    messageStateOf({ status: "SUCCESS", retryable: false, kind: "data_question" }), "answered");
  check("a real change reads as done",
    messageStateOf({ status: "SUCCESS", retryable: false, kind: "take_me_there" }), "done");
  check("something waiting on the owner reads as proposed",
    messageStateOf({ status: "PENDING", retryable: false, kind: "product_removal_request" }), "proposed");

  // THE ONE THAT MATTERS MOST. A tool that PROPOSES and reports SUCCESS
  // proposed successfully — the change itself has not happened. Reading that as
  // "done" is the precise claim this milestone exists to make impossible.
  for (const kind of [
    "product_removal_request", "image_request", "product_content_change_request",
    "campaign_request", "create_composition", "refine_storefront", "improve_storefront",
  ]) {
    check(`a successful ${kind} is still only proposed`,
      messageStateOf({ status: "SUCCESS", retryable: false, kind }), "proposed");
  }

  // ==========================================================================
  console.log("\n=== 3. A failure is never shown as anything else ===\n");
  // ==========================================================================
  check("a warning that can be retried is recoverable",
    messageStateOf({ status: "WARNING", retryable: true, kind: "approve_pending_changes" }),
    "failed_retryable");
  check("a warning that cannot is a plain failure",
    messageStateOf({ status: "WARNING", retryable: false, kind: "approve_pending_changes" }),
    "failed");
  check("and FAILED is a failure regardless of kind",
    messageStateOf({ status: "FAILED", retryable: false, kind: "data_question" }), "failed");
  // A failing data question must NOT read as answered — the kind is only
  // consulted once the status has already said the work succeeded.
  assert("a failed question is not 'answered'",
    messageStateOf({ status: "FAILED", retryable: true, kind: "data_question" }) !== "answered",
    "the kind must never override the status");

  // ==========================================================================
  console.log("\n=== 4. What the owner is told, and what it asks of them ===\n");
  // ==========================================================================
  // Nothing here names a tool, a status enum or a code path. The owner has no
  // idea any of those exist and must not learn about them from a badge.
  for (const [state, label] of Object.entries(MESSAGE_STATE_LABEL)) {
    if (label === null) continue;
    assert(`the ${state} label says nothing about internals`,
      !/PENDING|WARNING|SUCCESS|FAILED|execution|status|tool|handler/i.test(label), label);
  }
  // Both of these leave something outstanding; the other two do not.
  check("a proposal needs the owner", needsOwner("proposed"), true);
  check("so does a recoverable failure", needsOwner("failed_retryable"), true);
  check("a completed change does not", needsOwner("done"), false);
  check("nor does an answered question", needsOwner("answered"), false);
  check("nor an ordinary reply", needsOwner("spoken"), false);

  // ==========================================================================
  console.log("\n=== 5. The link is really written, end to end ===\n");
  // ==========================================================================
  // Everything above is the rule. This is the wiring: persistToolTurn writes
  // both rows and joins them, and without that join every message renders
  // "spoken" no matter what happened.
  const owner = await prisma.user.create({ data: { email: `ms-${uniq()}@test.local` } });
  const store = await prisma.store.create({
    data: { userId: owner.id, name: "State Test", slug: `ms-${uniq()}` },
  });

  await persistToolTurn({
    storeId: store.id,
    userId: owner.id,
    userMessage: "remove the worst seller and tell me why",
    userMessageChanges: null,
    writeUserMessage: true,
    results: [
      { handled: true, reply: "I've put that in front of you.", kind: "product_removal_request",
        executionStatus: "PENDING", outcome: "success" },
      { handled: true, reply: "It sold twice.", kind: "data_question" },
    ],
  });

  const written = await prisma.storeMessage.findMany({
    where: { storeId: store.id },
    orderBy: { createdAt: "asc" },
    include: { executionLog: { select: { status: true, retryable: true, metadata: true } } },
  });

  check("the merchant's own message carries no execution", written[0]?.executionLogId, null);
  check("and therefore renders as spoken",
    messageStateOf(written[0]?.executionLog
      ? { status: written[0].executionLog.status, retryable: written[0].executionLog.retryable, kind: null }
      : null),
    "spoken");

  assert("every assistant message is joined to what happened",
    written.filter((m) => m.role === "assistant").every((m) => m.executionLogId !== null),
    "without the join the conversation can only repeat what was said");

  const stateOf = (row: (typeof written)[number]): MessageState =>
    messageStateOf(row.executionLog
      ? {
          status: row.executionLog.status,
          retryable: row.executionLog.retryable,
          kind: (row.executionLog.metadata as { kind?: string } | null)?.kind ?? null,
        }
      : null);

  check("the proposal reads as waiting on the owner", stateOf(written[1]), "proposed");
  check("and the answer reads as answered", stateOf(written[2]), "answered");

  // THE DISAGREEMENT, as an assertion. The reply says "I've put that in front
  // of you" — reassuring prose — and the row says PENDING. Nothing about the
  // rendered state may come from the sentence.
  assert("the state comes from the row, not the words",
    written[1].content.includes("put that in front of you") && stateOf(written[1]) === "proposed",
    "a state derived from prose would restate J4's claim rather than check it");

  // And the inverse: a reply that CLAIMS success over a row that says it failed
  // must render as the failure. This is the case the whole milestone is for.
  const lying = await prisma.executionLog.create({
    data: {
      executionId: `ms-${uniq()}`, storeId: store.id, action: "GENESIS_STORE_MESSAGE",
      status: "WARNING", verified: false, message: "did not apply", retryable: true,
      actorType: "GENESIS", metadata: { kind: "approve_pending_changes" },
    },
  });
  const lyingMessage = await prisma.storeMessage.create({
    data: {
      storeId: store.id, role: "assistant",
      content: "Done. I applied all 3 changes and verified them.",
      executionLogId: lying.id,
    },
  });
  const reread = await prisma.storeMessage.findUniqueOrThrow({
    where: { id: lyingMessage.id },
    include: { executionLog: { select: { status: true, retryable: true, metadata: true } } },
  });
  check("a reply claiming success over a failed row renders as the failure",
    stateOf(reread), "failed_retryable");
  assert("even though the words say it was done and verified",
    reread.content.includes("applied all 3 changes"), reread.content);

  await prisma.store.deleteMany({ where: { id: store.id } });
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
