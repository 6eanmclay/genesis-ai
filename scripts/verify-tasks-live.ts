import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";

// TASKS — what Genesis is asking the owner to do, and what it must not touch:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-tasks-live.ts" -OutFile out.txt
//
// A task is the owner's own list. Everything here is about NOT disturbing it:
// not resetting a task they are mid-way through, not completing one they never
// opened, and not letting one source's sweep clear another source's work.
//
// THREE SCOPING RULES, each of which would fail silently and look like the list
// simply behaving oddly:
//
//   the upsert's update branch never touches status, so re-detecting a
//   condition cannot drag an IN_PROGRESS task back to OPEN under the owner
//
//   resolveStaleTasks is scoped by SOURCE, so the sweep for state issues cannot
//   complete a task raised by an observation — the same class of bug the notify
//   layer's dedupeKey prefixes exist to prevent
//
//   completeTasksForAction is scoped to IN_PROGRESS, so an untouched OPEN task
//   of the same action type is never silently marked done by somebody else's
//   action
//
// The upsert also carries a real race history: v1 reset status on every
// detection, v2 fixed that and introduced a create/create race that tripped the
// unique constraint live. The current shape is atomic on both counts, and both
// are exercised here.

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

  const { upsertTask, resolveStaleTasks, getOpenTasks, completeTasksForAction } = await import(
    "@/lib/dashboard/tasks"
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

  const owner = await prisma.user.create({ data: { email: "tasks@example.test" } });
  const store = await makeStore(owner.id, "Task Store");

  const task = (over: Record<string, unknown> = {}) => ({
    dedupeKey: "state_issue:no-products",
    source: "state_issue",
    title: "Add your first product",
    summary: "The store has nothing to sell yet.",
    context: { productCount: 0 },
    priority: "high",
    ...over,
  });

  const statusOf = async (dedupeKey: string) =>
    (await prisma.task.findFirstOrThrow({ where: { storeId: store.id, dedupeKey } })).status;

  // ==========================================================================
  console.log("\n=== 1. A task appears once, however often it is detected ===\n");
  // ==========================================================================
  await upsertTask(store.id, task() as never);
  check("it exists", await prisma.task.count({ where: { storeId: store.id } }), 1);
  check("open", await statusOf("state_issue:no-products"), "OPEN");

  // Re-detecting the same condition refreshes the wording rather than piling up
  // a second row the owner sees twice.
  await upsertTask(store.id, task({ title: "Add your first product (still)", summary: "Updated wording." }) as never);
  check("re-detecting it creates no second row", await prisma.task.count({ where: { storeId: store.id } }), 1);
  const refreshed = await prisma.task.findFirstOrThrow({ where: { storeId: store.id } });
  check("but the wording is refreshed", refreshed.title, "Add your first product (still)");

  // ==========================================================================
  console.log("\n=== 2. Re-detecting never drags a task the owner started ===\n");
  // ==========================================================================
  // THE RULE THE UPSERT'S update BRANCH EXISTS FOR. The owner has opened this
  // task and is working on it; a background detection pass must not quietly
  // reset it to OPEN underneath them.
  await prisma.task.updateMany({
    where: { storeId: store.id, dedupeKey: "state_issue:no-products" },
    data: { status: "IN_PROGRESS" },
  });
  await upsertTask(store.id, task({ summary: "Detected again." }) as never);
  check("an IN_PROGRESS task stays in progress", await statusOf("state_issue:no-products"), "IN_PROGRESS");
  assert("even though the detection ran again",
    (await prisma.task.findFirstOrThrow({ where: { storeId: store.id } })).summary === "Detected again.",
    "the wording updated, so the upsert genuinely ran");

  // ==========================================================================
  console.log("\n=== 3. But a genuine recurrence brings a finished one back ===\n");
  // ==========================================================================
  await prisma.task.updateMany({
    where: { storeId: store.id, dedupeKey: "state_issue:no-products" },
    data: { status: "COMPLETED", completedAt: new Date() },
  });
  await upsertTask(store.id, task() as never);
  check("a completed task reopens when the condition returns", await statusOf("state_issue:no-products"), "OPEN");
  const reopened = await prisma.task.findFirstOrThrow({ where: { storeId: store.id } });
  check("with its completion cleared", reopened.completedAt, null);
  check("on the same row, not a duplicate", await prisma.task.count({ where: { storeId: store.id } }), 1);

  // A dismissed task also returns — the owner dismissed a condition that has
  // since come back, which is a new fact rather than the same one.
  await prisma.task.updateMany({
    where: { storeId: store.id, dedupeKey: "state_issue:no-products" },
    data: { status: "DISMISSED", dismissedAt: new Date() },
  });
  await upsertTask(store.id, task() as never);
  check("a dismissed task reopens too", await statusOf("state_issue:no-products"), "OPEN");
  check("with its dismissal cleared",
    (await prisma.task.findFirstOrThrow({ where: { storeId: store.id } })).dismissedAt, null);

  // ==========================================================================
  console.log("\n=== 4. Concurrent detection does not trip the constraint ===\n");
  // ==========================================================================
  // The real race this shape was rewritten for: two detection passes both saw
  // "does not exist" and both called create(), failing live on the unique
  // constraint.
  const racy = task({ dedupeKey: "state_issue:racy", title: "Raced" });
  const settled = await Promise.allSettled([
    upsertTask(store.id, racy as never),
    upsertTask(store.id, racy as never),
    upsertTask(store.id, racy as never),
  ]);
  assert("three concurrent upserts all succeed",
    settled.every((r) => r.status === "fulfilled"),
    settled.map((r) => (r.status === "rejected" ? String(r.reason).slice(0, 80) : "ok")).join(" | "));
  check("and produce exactly one task",
    await prisma.task.count({ where: { storeId: store.id, dedupeKey: "state_issue:racy" } }), 1);

  // ==========================================================================
  console.log("\n=== 5. One source's sweep never clears another's ===\n");
  // ==========================================================================
  // Same class as the notify layer's prefix namespacing: two independent
  // sources each resolve "everything of mine that is no longer true", and
  // neither knows the other's keys.
  await upsertTask(store.id, task({ dedupeKey: "observation:slow-week", source: "observation", title: "A quiet week" }) as never);
  await upsertTask(store.id, task({ dedupeKey: "brand_gap:no-logo", source: "brand_gap", title: "No logo yet" }) as never);

  const beforeSweep = (await getOpenTasks(store.id)).map((t) => t.dedupeKey).sort();
  assert("three sources have open tasks", beforeSweep.length >= 3, beforeSweep.join(", "));

  // The state_issue sweep runs with nothing fresh: its own tasks complete.
  await resolveStaleTasks(store.id, "state_issue", []);
  const afterSweep = (await getOpenTasks(store.id)).map((t) => t.dedupeKey).sort();
  assert("the state-issue tasks are completed",
    !afterSweep.some((k) => k.startsWith("state_issue:")), afterSweep.join(", "));
  assert("the observation task is untouched", afterSweep.includes("observation:slow-week"),
    "another source's still-true task must survive");
  assert("and so is the brand-gap task", afterSweep.includes("brand_gap:no-logo"));

  // A sweep that names a still-fresh key keeps it.
  await upsertTask(store.id, task({ dedupeKey: "state_issue:no-products" }) as never);
  await resolveStaleTasks(store.id, "state_issue", ["state_issue:no-products"]);
  check("a task still in the fresh set stays open", await statusOf("state_issue:no-products"), "OPEN");

  // ==========================================================================
  console.log("\n=== 6. Completing by action only touches what was started ===\n");
  // ==========================================================================
  // The documented rule: scoped to IN_PROGRESS, so an unrelated still-untouched
  // task of the same action type is never silently marked done by somebody
  // else's action.
  const started = task({
    dedupeKey: "chat:started", source: "chat", title: "Started one", actionType: "update_hero",
  });
  const untouched = task({
    dedupeKey: "chat:untouched", source: "chat", title: "Untouched one", actionType: "update_hero",
  });
  await upsertTask(store.id, started as never);
  await upsertTask(store.id, untouched as never);
  await prisma.task.updateMany({
    where: { storeId: store.id, dedupeKey: "chat:started" },
    data: { status: "IN_PROGRESS" },
  });

  await completeTasksForAction(store.id, "update_hero");

  check("the task the owner opened is completed", await statusOf("chat:started"), "COMPLETED");
  check("the one they never opened is untouched", await statusOf("chat:untouched"), "OPEN");
  assert(
    "so acting on one task cannot silently tick off another of the same kind",
    (await statusOf("chat:untouched")) === "OPEN"
  );

  // A different action type completes nothing here.
  await prisma.task.updateMany({
    where: { storeId: store.id, dedupeKey: "chat:untouched" },
    data: { status: "IN_PROGRESS" },
  });
  await completeTasksForAction(store.id, "update_seo");
  check("an unrelated action completes nothing", await statusOf("chat:untouched"), "IN_PROGRESS");

  // ==========================================================================
  console.log("\n=== 7. The list is the owner's own, per business ===\n");
  // ==========================================================================
  const other = await makeStore(owner.id, "Other Task Store");
  check("a new business has an empty list", await getOpenTasks(other.id), []);

  await upsertTask(other.id, task({ dedupeKey: "state_issue:no-products", title: "Theirs" }) as never);
  const theirs = await getOpenTasks(other.id);
  check("its own task is its own", theirs.map((t) => t.title), ["Theirs"]);
  assert("sharing a dedupeKey with the neighbour is fine",
    theirs.length === 1, "the key is unique per store, not globally");

  // Sweeping one business never reaches the other.
  await resolveStaleTasks(other.id, "state_issue", []);
  check("the swept business has none of that source left",
    (await getOpenTasks(other.id)).filter((t) => t.source === "state_issue").length, 0);
  check("while the neighbour keeps its own",
    (await getOpenTasks(store.id)).filter((t) => t.dedupeKey === "state_issue:no-products").length, 1);

  // And completing by action does not cross either.
  await upsertTask(other.id, task({ dedupeKey: "chat:theirs", source: "chat", actionType: "update_hero" }) as never);
  await prisma.task.updateMany({
    where: { storeId: other.id, dedupeKey: "chat:theirs" }, data: { status: "IN_PROGRESS" },
  });
  await completeTasksForAction(store.id, "update_hero");
  check("completing in one business leaves the other's in progress",
    (await prisma.task.findFirstOrThrow({ where: { storeId: other.id, dedupeKey: "chat:theirs" } })).status,
    "IN_PROGRESS");

  // ==========================================================================
  console.log("\n=== 8. Only open tasks are open ===\n");
  // ==========================================================================
  const open = await getOpenTasks(store.id);
  assert("nothing completed or dismissed is listed",
    open.every((t) => t.status === "OPEN"), open.map((t) => t.status).join(", "));
  assert("oldest first, so the list does not reshuffle as it is worked",
    open.every((t, i) => i === 0 || open[i - 1].createdAt.getTime() <= t.createdAt.getTime()));

  await prisma.$disconnect();
  await db.close();

  console.log(`\n${failures === 0 ? "All task assertions passed." : `${failures} assertion(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
