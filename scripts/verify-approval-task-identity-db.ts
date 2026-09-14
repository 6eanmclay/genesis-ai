import "@/scripts/lib/allowServerOnly";
import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prismaSystem } from "@/lib/prisma";
import { completeTasksForAction } from "@/lib/dashboard/tasks";
import { relevantTaskFor } from "@/lib/j4/relevantTask";

// AN APPROVAL KNOWS WHICH TASK IT CAME OUT OF:
//
//   npx tsx scripts/run-db-suites.ts approval-task-identity
//
// ============ THE CONTRACT (2026-09-14) ================================
//
// completeTasksForAction had one way to find the task an approval finished:
// match the actionType against IN_PROGRESS tasks. That is a guess. Two tasks of
// one type both close, and the right one closing is luck.
//
// ApprovalRequest.taskId is the identity. Stamped AT CREATION from the
// conversation or the thread (lib/j4/relevantTask.ts), never inferred later
// from actionType, wording, record identity or recency, and null whenever the
// turn is not demonstrably about one piece of work.
//
// TWO PATHS, NOT TWO EQUAL PATHS. The actionType branch survives only for
// approvals that genuinely have no task identity — the AI review, autonomous
// findings, storefront proposals, marketing assets, and every row written
// before the column existed. Section 5 asserts it still works; it is not
// evidence that guessing is acceptable for new work.

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

const ACTION = "update_theme";

async function main(): Promise<void> {
  await requireTestDatabase(prismaSystem);
  const stamp = Date.now();
  const user = await prismaSystem.user.create({ data: { email: `ati-${stamp}@example.test` } });
  const store = await prismaSystem.store.create({
    data: { userId: user.id, name: "Copper Works", slug: `ati-${stamp}`, currency: "USD" },
  });

  const makeTask = (tag: string, status = "IN_PROGRESS") =>
    prismaSystem.task.create({
      data: {
        storeId: store.id, dedupeKey: `ati:${tag}:${stamp}`, source: "manual",
        title: `Task ${tag}`, summary: `The ${tag} work.`, context: {},
        priority: "opportunity", status, actionType: ACTION,
      },
    });

  const makeApproval = (taskId: string | null) =>
    prismaSystem.approvalRequest.create({
      data: {
        storeId: store.id, actionType: ACTION, taskId,
        input: {}, previousValues: {}, summary: "Change the theme.", status: "PENDING",
      },
    });

  const statusOf = async (id: string) =>
    (await prismaSystem.task.findUnique({ where: { id }, select: { status: true } }))?.status;

  // ==================================================================
  console.log("\n1. A task-originated approval carries that exact task\n");
  // ==================================================================
  const alpha = await makeTask("alpha");
  {
    // How it really gets there: a seeded turn links the thread to the task,
    // relevantTaskFor resolves it, and the approval is stamped with THAT id.
    await prismaSystem.storeMessage.create({
      data: { storeId: store.id, role: "assistant", content: "Let's do alpha.", taskId: alpha.id },
    });
    const resolved = await relevantTaskFor({ storeId: store.id, conversationId: null });
    assert("the thread resolves to the task", resolved?.id === alpha.id, resolved?.title ?? "(none)");

    const approval = await makeApproval(resolved?.id ?? null);
    assert("  and the approval carries it", approval.taskId === alpha.id, String(approval.taskId));

    await completeTasksForAction(store.id, ACTION, approval.taskId);
    assert("  approving completes that exact task", (await statusOf(alpha.id)) === "COMPLETED");
  }

  // ==================================================================
  console.log("\n2. Same actionType, different task — untouched\n");
  // ==================================================================
  //
  // THE FAILURE THE COLUMN EXISTS FOR. Before identity, completing one of
  // these closed both: they share an actionType and both are IN_PROGRESS.
  {
    const beta = await makeTask("beta");
    const gamma = await makeTask("gamma");
    const approval = await makeApproval(beta.id);

    await completeTasksForAction(store.id, ACTION, approval.taskId);
    assert("the named task completes", (await statusOf(beta.id)) === "COMPLETED");
    assert("  and the other task of the same type stays open",
      (await statusOf(gamma.id)) === "IN_PROGRESS", String(await statusOf(gamma.id)));
  }

  // ==================================================================
  console.log("\n3. Ambiguity resolves to NULL, never to a guess\n");
  // ==================================================================
  {
    // A second task linked into the same thread. relevantTaskFor refuses.
    const delta = await makeTask("delta");
    await prismaSystem.storeMessage.create({
      data: { storeId: store.id, role: "assistant", content: "And delta.", taskId: delta.id },
    });
    const resolved = await relevantTaskFor({ storeId: store.id, conversationId: null });
    assert("two linked tasks resolve to nothing", resolved === null, resolved?.title ?? "");

    const approval = await makeApproval(resolved?.id ?? null);
    assert("  so the approval is stamped NULL", approval.taskId === null, String(approval.taskId));
  }

  // ==================================================================
  console.log("\n4. An approval outside any task is valid and NULL\n");
  // ==================================================================
  {
    const approval = await makeApproval(null);
    assert("it is created", !!approval.id);
    assert("  with taskId NULL", approval.taskId === null, String(approval.taskId));
    assert("  and is a normal pending approval", approval.status === "PENDING", approval.status);
  }

  // ==================================================================
  console.log("\n5. LEGACY ONLY: actionType still completes a task with no identity\n");
  // ==================================================================
  //
  // Asserted so the fallback is not removed by accident — NOT as evidence that
  // guessing is acceptable. It closes whichever IN_PROGRESS task shares the
  // type, which is exactly the imprecision the column replaces.
  {
    const legacy = await makeTask("legacy");
    const approval = await makeApproval(null);
    await completeTasksForAction(store.id, ACTION, approval.taskId);
    assert("a null-task approval still completes by actionType",
      (await statusOf(legacy.id)) === "COMPLETED", String(await statusOf(legacy.id)));
  }

  // ==================================================================
  console.log("\n6. A reverted approval inherits, never re-resolves\n");
  // ==================================================================
  {
    const epsilon = await makeTask("epsilon");
    const original = await makeApproval(epsilon.id);
    // The owner is now somewhere else entirely — a different thread, a
    // different task. A revert must still belong to the original's work.
    const revert = await prismaSystem.approvalRequest.create({
      data: {
        storeId: store.id, actionType: original.actionType, taskId: original.taskId,
        input: {}, previousValues: {}, summary: `Reverted: ${original.summary}`, status: "PENDING",
      },
    });
    assert("the revert carries the original's task", revert.taskId === epsilon.id, String(revert.taskId));
  }

  // ==================================================================
  console.log("\n7. Another business's task cannot be completed\n");
  // ==================================================================
  {
    const otherUser = await prismaSystem.user.create({ data: { email: `ati2-${stamp}@example.test` } });
    const otherStore = await prismaSystem.store.create({
      data: { userId: otherUser.id, name: "Elsewhere", slug: `ati2-${stamp}`, currency: "USD" },
    });
    const theirs = await prismaSystem.task.create({
      data: {
        storeId: otherStore.id, dedupeKey: `ati:theirs:${stamp}`, source: "manual",
        title: "Their work", summary: "Not ours.", context: {},
        priority: "opportunity", status: "IN_PROGRESS", actionType: ACTION,
      },
    });

    // OUR store, THEIR task id — the shape a forged or stale id would take.
    await completeTasksForAction(store.id, ACTION, theirs.id);
    assert("their task is untouched by our completion",
      (await statusOf(theirs.id)) === "IN_PROGRESS", String(await statusOf(theirs.id)));
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
