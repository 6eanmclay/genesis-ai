import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prismaSystem } from "@/lib/prisma";
import { runDueTasks, isDue, lastSuccesses, overdueRatio } from "@/lib/scheduler/run";
import { schedulerHealth, schedulerNeedsAttention, dueNow } from "@/lib/scheduler/health";
import { SCHEDULED_TASKS, LANE_ORDER, taskByKey, tasksInLane, type ScheduledTask, type Lane } from "@/lib/scheduler/registry";
import { JOB_KINDS, HANDLERS } from "@/lib/jobs/registry";
import { readFileSync } from "node:fs";

// THE SCHEDULING LAYER:
//
//   part of the database sweep — npx tsx scripts/run-db-suites.ts scheduler-db
//
// ============ THE ONE CLAIM EVERYTHING RESTS ON (2026-08-30) ===========
//
// "When the paid infrastructure arrives, the schedules can be switched on
// without redesigning the application."
//
// That is only true if a task's cadence is independent of how often a trigger
// fires. So the central assertion here is not that tasks run — it is that
// offering a daily task a hundred chances in a simulated minute runs it ONCE.
// If that holds, adding a two-minute cron entry is configuration; if it does
// not, it is a rewrite, and every comment claiming otherwise is a lie.
//
// ============ AND THE ONE THAT PROTECTS THE REFACTOR ==================
//
// Eleven responsibilities moved out of a route handler. The worst possible
// outcome is not a bug — it is one of them silently no longer existing. So the
// registry is checked against the list of what that route used to do, by name.
//
// ============ WHAT IS DELIBERATELY NOT RUN HERE =======================
//
// Sourcing, connector syncs, intelligence cycles, reconciliation and the
// notification sweep are never invoked. They call third parties, send notices,
// or cost money. The runner is proven against tasks whose behaviour this file
// dictates; the registry is proven by inspection; and the two are exercised
// together only through tasks that are safe to actually run.

let failures = 0;
let passes = 0;
function assert(name: string, ok: boolean, detail = ""): void {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  — ${detail}` : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  assert(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** A task this suite fully controls. Never in the real registry. */
function testTask(over: Partial<ScheduledTask> & { key: string }): ScheduledTask {
  return {
    lane: "maintenance",
    purpose: "a task this suite controls",
    everyMs: DAY,
    enabled: () => true,
    minBudgetMs: 1_000,
    // Defaulted alongside the minimum. Without it a test task spread over
    // these defaults produced `Date.now() + undefined` — a NaN deadline — which
    // no real task can reach, because the field is required by the type.
    maxBudgetMs: 1_000,
    run: async () => undefined,
    ...over,
  };
}

async function main(): Promise<void> {
  await requireTestDatabase(prismaSystem);
  const stamp = Date.now();
  const k = (name: string) => `test.${name}.${stamp}`;

  console.log("\n--- the cadence rule, without a clock or a database ---\n");
  {
    const daily = { everyMs: DAY };
    const now = new Date("2026-08-30T06:00:00Z");
    eq("a task that has never run is due", isDue(daily, undefined, now), true);
    eq("one that ran a minute ago is not", isDue(daily, new Date(now.getTime() - MINUTE), now), false);
    eq("one that ran exactly an interval ago is", isDue(daily, new Date(now.getTime() - DAY), now), true);
    eq("one that ran a day and a second ago is", isDue(daily, new Date(now.getTime() - DAY - 1000), now), true);
    eq("and one that ran a second short is not", isDue(daily, new Date(now.getTime() - DAY + 1000), now), false);
  }

  console.log("\n--- offering a daily task a hundred chances runs it once ---\n");
  {
    // ============ THE ASSERTION THE WHOLE DESIGN RESTS ON ==========
    //
    // This is what "switch the schedules on later without redesigning" means,
    // stated as a test. A frequent trigger changes the LATENCY of due work and
    // must change no task's cadence.
    let ran = 0;
    const task = testTask({ key: k("daily"), everyMs: DAY, run: async () => { ran++; } });
    const base = Date.now();

    for (let i = 0; i < 100; i++) {
      // A hundred ticks across a simulated minute — a two-minute cron's worth
      // of chances, compressed.
      await runDueTasks({
        trigger: "test.frequent", tasks: [task],
        now: new Date(base + i * 600),
      });
    }
    eq("a daily task offered a hundred chances ran once", ran, 1);

    // And it becomes due again exactly when its interval says, not when a
    // trigger says.
    await runDueTasks({ trigger: "test.frequent", tasks: [task], now: new Date(base + DAY + 1000) });
    eq("and again once its interval has passed", ran, 2);
  }

  console.log("\n--- a failed task is due again immediately ---\n");
  {
    // Due-ness reads the last SUCCESS, not the last attempt — which is what
    // makes a failing recompute retry on the next tick with no retry machinery.
    let attempts = 0;
    const task = testTask({
      key: k("failing"), everyMs: DAY,
      run: async () => { attempts++; throw new Error("it did not work"); },
    });
    const base = Date.now();

    const first = await runDueTasks({ trigger: "test", tasks: [task], now: new Date(base) });
    eq("the failure is reported as a failure", first.outcomes[0].status, "failed");
    assert("with the reason", first.outcomes[0].reason?.includes("it did not work") ?? false);

    // One second later — far inside a daily interval — it is due again.
    await runDueTasks({ trigger: "test", tasks: [task], now: new Date(base + 1000) });
    eq("and it is tried again on the very next tick", attempts, 2);

    const rows = await prismaSystem.scheduledTaskRun.findMany({ where: { taskKey: task.key } });
    eq("both attempts are recorded", rows.length, 2);
    assert("both as failures", rows.every((r) => r.outcome === "failed"), JSON.stringify(rows.map((r) => r.outcome)));
    assert("with a duration", rows.every((r) => r.durationMs !== null));
  }

  console.log("\n--- one failing task does not take the others down ---\n");
  {
    // This was eleven hand-written try/catch blocks and is now structural. It
    // is also the property a refactor most easily loses.
    const order: string[] = [];
    const tasks = [
      testTask({ key: k("a"), run: async () => { order.push("a"); } }),
      testTask({ key: k("boom"), run: async () => { order.push("boom"); throw new Error("no"); } }),
      testTask({ key: k("c"), run: async () => { order.push("c"); } }),
    ];
    const result = await runDueTasks({ trigger: "test", tasks });
    eq("every task was attempted", order, ["a", "boom", "c"]);
    eq("and the failure is isolated to its own outcome",
      result.outcomes.map((o) => o.status), ["ran", "failed", "ran"]);
  }

  console.log("\n--- a task that is off never runs, and says why ---\n");
  {
    let ran = 0;
    const task = testTask({ key: k("off"), enabled: () => false, run: async () => { ran++; } });
    const result = await runDueTasks({ trigger: "test", tasks: [task] });
    eq("it did not run", ran, 0);
    eq("it is reported as skipped", result.outcomes[0].status, "skipped");
    eq("because it is not enabled", result.outcomes[0].reason, "not enabled");
    const rows = await prismaSystem.scheduledTaskRun.count({ where: { taskKey: task.key } });
    // No record, because nothing happened. A skipped task writing a row would
    // make "it ran and did nothing" and "it was off" look the same again.
    eq("and nothing is recorded for it", rows, 0);
  }

  console.log("\n--- running out of time defers, and says so ---\n");
  {
    // ============ THE PAIR THAT USED TO BE INDISTINGUISHABLE =======
    //
    // The route this replaces awaited eleven things with no ceiling: a slow
    // stage consumed the runtime and the stages after it were never reached
    // AND never recorded. "Skipped for lack of time" and "found nothing to do"
    // looked identical, which is the worst confusion a scheduler can have.
    let expensiveRan = 0;
    let cheapRan = 0;
    const tasks = [
      testTask({
        key: k("slow"), lane: "timely", minBudgetMs: 100,
        run: async () => { expensiveRan++; await new Promise((r) => setTimeout(r, 120)); },
      }),
      testTask({ key: k("needsLots"), lane: "recompute", minBudgetMs: 10 * MINUTE, run: async () => { cheapRan++; } }),
      testTask({ key: k("cheap"), lane: "maintenance", minBudgetMs: 5, run: async () => { cheapRan++; } }),
    ];
    const result = await runDueTasks({ trigger: "test", tasks, budgetMs: 250 });

    eq("the affordable task ran", expensiveRan, 1);
    const deferred = result.outcomes.find((o) => o.key === k("needsLots"));
    eq("the one that could not fit is skipped", deferred?.status, "skipped");
    assert("as DEFERRED, not as 'not due'", deferred?.reason?.startsWith("deferred") ?? false, deferred?.reason);
    eq("and it is named in the deferred list", result.deferred, [k("needsLots")]);
    // A cheap task after an expensive one still fits — deferring must not be a
    // hard stop, or one costly task would silently cancel the rest of the tick.
    eq("a cheap task after it still ran", cheapRan, 1);
  }

  console.log("\n--- cost of delay decides the order ---\n");
  {
    const order: string[] = [];
    const tasks = [
      testTask({ key: k("o"), lane: "outbound", run: async () => { order.push("outbound"); } }),
      testTask({ key: k("m"), lane: "maintenance", run: async () => { order.push("maintenance"); } }),
      testTask({ key: k("q"), lane: "queue", run: async () => { order.push("queue"); } }),
      testTask({ key: k("t"), lane: "timely", run: async () => { order.push("timely"); } }),
      testTask({ key: k("r"), lane: "recompute", run: async () => { order.push("recompute"); } }),
    ];
    await runDueTasks({ trigger: "test", tasks });
    // An invocation that runs out of time loses a supplier search, never a
    // customer's receipt.
    eq("the lanes run in cost-of-delay order", order,
      ["queue", "timely", "recompute", "maintenance", "outbound"]);
  }

  console.log("\n--- falling behind is what earns priority ---\n");
  {
    // ============ THE DEFECT THIS EXISTS FOR (2026-09-02) =============
    //
    // Order within a lane used to be position in the registry — a constant.
    // So a task behind an expensive one lost the budget race every tick, in
    // the same order, forever, and two real tasks (intelligence.cycles,
    // sourcing.discovery) had never run once while eleven others ran daily.
    //
    // `overdueRatio` is pure, so the property can be proved without a clock or
    // a database, the same reasoning isDue was separated for.
    const now = new Date("2026-09-02T12:00:00.000Z");
    const hoursAgo = (h: number) => new Date(now.getTime() - h * 60 * 60_000);

    eq("a task that has never run sorts first",
      overdueRatio({ everyMs: DAY }, undefined, now), Number.POSITIVE_INFINITY);
    eq("a daily task three days late scores three",
      overdueRatio({ everyMs: DAY }, hoursAgo(72), now), 3);
    eq("an hourly task one hour late scores one",
      overdueRatio({ everyMs: 60 * 60_000 }, hoursAgo(1), now), 1);
    // THE COMPARISON THAT MATTERS: absolute lateness would rank the daily task
    // below the hourly one on raw milliseconds. Relative lateness does not.
    assert("a daily task three days late outranks an hourly task an hour late",
      overdueRatio({ everyMs: DAY }, hoursAgo(72), now) >
        overdueRatio({ everyMs: 60 * 60_000 }, hoursAgo(1), now));

    // ---- and the runner actually uses it ----------------------------
    const order: string[] = [];
    const behind = k("behind");
    const ahead = k("ahead");
    // `behind` succeeded once, long ago; `ahead` succeeded moments ago. Both
    // are due. The one further past its own interval must go first, whatever
    // order they were declared in.
    await prismaSystem.scheduledTaskRun.create({
      data: { taskKey: behind, outcome: "succeeded", startedAt: hoursAgo(24 * 9), finishedAt: hoursAgo(24 * 9) },
    });
    await prismaSystem.scheduledTaskRun.create({
      data: { taskKey: ahead, outcome: "succeeded", startedAt: hoursAgo(25), finishedAt: hoursAgo(25) },
    });
    await runDueTasks({
      trigger: "test",
      tasks: [
        // Declared with the LESS overdue one first, so registry position and
        // overdue-ness disagree and only one of them can be what decided.
        testTask({ key: ahead, lane: "recompute", run: async () => { order.push("ahead"); } }),
        testTask({ key: behind, lane: "recompute", run: async () => { order.push("behind"); } }),
      ],
    });
    eq("the task furthest behind ran first", order, ["behind", "ahead"]);
  }

  console.log("\n--- a lane still outranks being overdue ---\n");
  {
    // Fairness reorders WITHIN a lane. It must never let a supplier search
    // jump a customer's receipt just because it has been waiting longer.
    const order: string[] = [];
    const starved = k("starvedOutbound");
    await prismaSystem.scheduledTaskRun.create({
      data: {
        taskKey: starved, outcome: "succeeded",
        startedAt: new Date(Date.now() - 40 * DAY), finishedAt: new Date(Date.now() - 40 * DAY),
      },
    });
    await runDueTasks({
      trigger: "test",
      tasks: [
        testTask({ key: starved, lane: "outbound", run: async () => { order.push("outbound"); } }),
        testTask({ key: k("freshQueue"), lane: "queue", run: async () => { order.push("queue"); } }),
      ],
    });
    eq("cost of delay still decides first", order, ["queue", "outbound"]);
  }

  console.log("\n--- the minimum is a minimum, and the deadline is passed on ---\n");
  {
    // A task is started when its MINIMUM fits, not its worst case. Under the
    // old rule this task declared what it might take and was refused with most
    // of the invocation still free.
    let ran = 0;
    let sawDeadline: number | null = null;
    const started = Date.now();
    await runDueTasks({
      trigger: "test",
      budgetMs: 100_000,
      tasks: [
        testTask({
          key: k("minimal"),
          minBudgetMs: 1_000,
          run: async (ctx) => { ran++; sawDeadline = ctx.deadlineAt; },
        }),
      ],
    });
    eq("a task whose minimum fits is started", ran, 1);
    assert("and is told when to stop",
      sawDeadline !== null && sawDeadline > started,
      `${sawDeadline} against a start of ${started}`);
  }

  console.log("\n--- a task's deadline is its own, and never the whole tick ---\n");
  {
    // ============ C1: THE FIX FOR STARVING THE LANES BEHIND ===========
    //
    // Every task used to receive `startedAt + budgetMs` — the end of the whole
    // invocation. So a task that honoured its deadline honoured the wrong one:
    // it would work until the tick ended and everything behind it deferred.
    // The fix for starvation had quietly created a second way to starve.
    //
    // A task now gets min(end of invocation, now + its own allowance).
    let seen: number | null = null;
    const started = Date.now();
    const INVOCATION = 200_000;
    const ALLOWANCE = 20_000;

    await runDueTasks({
      trigger: "test",
      budgetMs: INVOCATION,
      tasks: [
        testTask({
          key: k("bounded"),
          minBudgetMs: 1_000,
          maxBudgetMs: ALLOWANCE,
          run: async (ctx) => { seen = ctx.deadlineAt; },
        }),
      ],
    });

    assert("the deadline is the task's own allowance",
      seen !== null && seen <= started + ALLOWANCE + 2_000,
      `${seen} against an allowance ending at ${started + ALLOWANCE}`);
    assert("and not the end of the invocation",
      seen !== null && seen < started + INVOCATION - 1_000,
      "the task was handed the whole tick, which is the defect this replaced");

    // ============ C2: THE INVOCATION IS STILL THE OUTER BOUNDARY ======
    //
    // A task whose allowance is larger than what remains must not be told it
    // may run past the end of the tick. The min() is the whole guarantee, and
    // it is asserted rather than read out of the expression.
    let greedy: number | null = null;
    const smallStart = Date.now();
    const SMALL = 5_000;
    await runDueTasks({
      trigger: "test",
      budgetMs: SMALL,
      tasks: [
        testTask({
          key: k("greedy"),
          minBudgetMs: 1_000,
          maxBudgetMs: 10 * 60_000,
          run: async (ctx) => { greedy = ctx.deadlineAt; },
        }),
      ],
    });
    assert("a task asking for more than the tick has is capped by the tick",
      greedy !== null && greedy <= smallStart + SMALL + 1_000,
      `${greedy} against a tick ending at ${smallStart + SMALL}`);
  }

  console.log("\n--- no declared allowance can outlast the safety margin ---\n");
  {
    // The real registry, against the real trigger's budget. A task whose
    // allowance exceeded the invocation could never overrun by more than the
    // cap above — but it would also never be able to use what it declared,
    // which is a declaration that lies.
    const INVOCATION = 4 * MINUTE;
    for (const task of SCHEDULED_TASKS) {
      assert(`${task.key}'s allowance fits the daily invocation`,
        task.maxBudgetMs <= INVOCATION, `${task.maxBudgetMs} against ${INVOCATION}`);
    }
  }

  console.log("\n--- the expensive review is shed before the watchdog ---\n");
  {
    // ============ WHY THE LANE MATTERS (2026-09-02) ===================
    //
    // The AI review measured 29-39 seconds and about fifteen cents per store in
    // production, and was 98.7% of the intelligence cycle. It is its own task
    // now, and its lane is the one already defined for work that "makes
    // third-party calls on its own initiative" and that an invocation running
    // out of time "should lose before it loses a customer's receipt".
    //
    // The consequence that matters: every maintenance task, the ops.alerts
    // watchdog included, is now considered ahead of it. Noticing the platform
    // is broken must never queue behind an opinion about a storefront.
    const review = SCHEDULED_TASKS.find((task) => task.key === "intelligence.aiReview");
    const cycles = SCHEDULED_TASKS.find((task) => task.key === "intelligence.cycles");
    const alerts = SCHEDULED_TASKS.find((task) => task.key === "ops.alerts");

    assert("the AI review is its own task", review !== undefined);
    eq("in the outbound lane", review?.lane, "outbound");
    eq("while the deterministic cycle stays in recompute", cycles?.lane, "recompute");
    assert("so the watchdog is considered before the review",
      LANE_ORDER.indexOf(alerts!.lane) < LANE_ORDER.indexOf(review!.lane),
      `${alerts?.lane} vs ${review?.lane}`);

    assert("the deterministic cycle no longer claims minutes it does not need",
      (cycles?.minBudgetMs ?? Infinity) <= 10_000,
      `${cycles?.minBudgetMs} - it measured about 380ms per store`);
    assert("the review claims enough for one real review",
      (review?.minBudgetMs ?? 0) >= 40_000,
      `${review?.minBudgetMs} - one measured 28.9s to 38.9s`);

    // THE WATCHDOG FITS THE LEFTOVER IT PREVIOUSLY MISSED. It was deferred
    // with roughly 30s remaining against a 30s claim it never needed.
    assert("the watchdog fits in the margin that previously deferred it",
      (alerts?.minBudgetMs ?? Infinity) <= 10_000,
      `${alerts?.minBudgetMs} - it reads one source and a handful of counts`);
    assert("without shortening what it is allowed to take",
      alerts?.maxBudgetMs === 30_000, `${alerts?.maxBudgetMs}`);
  }

  console.log("\n--- supplier discovery stays off ---\n");
  {
    // ============ A BOUNDARY, NOT AN OPINION (2026-09-02) =============
    //
    // sourcing.discovery is the only task that makes third-party calls on its
    // own initiative. It was `enabled: always` and had never once run, because
    // it declared the entire invocation budget. Fixing the scheduler would
    // have started it as a side effect of unrelated work, so Sean's ruling was
    // that its observed behaviour is preserved by changing its declared state.
    //
    // This asserts the boundary rather than trusting a comment, because the
    // failure mode is silent: nobody notices a task that starts working.
    const sourcing = SCHEDULED_TASKS.find((task) => task.key === "sourcing.discovery");
    assert("sourcing.discovery is still in the registry", sourcing !== undefined);
    assert("and is switched off unless explicitly enabled",
      sourcing !== undefined && sourcing.enabled() === false,
      "it would begin making outbound supplier calls on the next tick");
  }

  console.log("\n--- the tasks do not all fit, and that is now survivable ---\n");
  {
    // THE ASSERTION THAT WAS ONE STEP SHORT. The loop above asks whether each
    // task fits alone; both starved tasks did. What was never asked is whether
    // they fit TOGETHER, which they do not and never will on one daily cron.
    const enabled = SCHEDULED_TASKS.filter((task) => task.enabled());
    const declared = enabled.reduce((sum, task) => sum + task.minBudgetMs, 0);
    const invocation = 4 * MINUTE;
    // Recorded rather than asserted away: this is TRUE and is the reason
    // fairness ordering has to exist. If it ever stopped being true, the
    // ordering would still be correct, merely unexercised.
    console.log(
      `  NOTE  enabled tasks declare ${Math.round(declared / 1000)}s of minimum budget ` +
      `against a ${invocation / 1000}s invocation — so an invocation cannot run them all, ` +
      `and which ones it runs must rotate`
    );
    assert("no single task claims more than a whole invocation",
      enabled.every((task) => task.minBudgetMs <= invocation),
      JSON.stringify(enabled.filter((task) => task.minBudgetMs > invocation).map((task) => task.key)));
    assert("the intelligence cycle can start inside a partly-used invocation",
      (SCHEDULED_TASKS.find((task) => task.key === "intelligence.cycles")?.minBudgetMs ?? Infinity) <= 60_000,
      "it declared three minutes and was deferred every tick");
  }

  console.log("\n--- a lane filter runs only that lane ---\n");
  {
    const order: string[] = [];
    const tasks = [
      testTask({ key: k("lq"), lane: "queue", run: async () => { order.push("queue"); } }),
      testTask({ key: k("lt"), lane: "timely", run: async () => { order.push("timely"); } }),
      testTask({ key: k("lo"), lane: "outbound", run: async () => { order.push("outbound"); } }),
    ];
    // Exactly what the frequent trigger asks for.
    await runDueTasks({ trigger: "test", tasks, lanes: ["queue", "timely"] });
    eq("the frequent lanes ran", order, ["queue", "timely"]);
    assert("and the outbound task was not even considered",
      await prismaSystem.scheduledTaskRun.count({ where: { taskKey: k("lo") } }) === 0);
  }

  console.log("\n--- a run is recorded before the work, not after ---\n");
  {
    // ============ WHY THAT ORDER MATTERS ===========================
    //
    // A process killed mid-task must leave evidence of WHICH task was running.
    // Recording only on completion means the one run worth investigating is the
    // one that writes nothing.
    let sawOwnRow = false;
    const task = testTask({
      key: k("records"),
      run: async () => {
        const row = await prismaSystem.scheduledTaskRun.findFirst({ where: { taskKey: k("records") } });
        sawOwnRow = row?.outcome === "running";
      },
    });
    await runDueTasks({ trigger: "test.recording", tasks: [task] });
    assert("the task could see its own row, marked running, while it ran", sawOwnRow);

    const row = await prismaSystem.scheduledTaskRun.findFirst({ where: { taskKey: task.key } });
    eq("and it is succeeded afterwards", row?.outcome, "succeeded");
    assert("with a finish time", !!row?.finishedAt);
    eq("and the trigger that woke it", row?.trigger, "test.recording");
    assert("under a correlation id", !!row?.correlationId);
  }

  console.log("\n--- the run record is evidence, never a work item ---\n");
  {
    // Sean: anything that can safely be recomputed should stay recomputable
    // rather than acquiring durable state. The test of whether state is
    // load-bearing is whether deleting it changes behaviour — here it must
    // return the system to exactly its first-deploy condition and nothing else.
    const task = testTask({ key: k("stateless"), everyMs: DAY });
    await runDueTasks({ trigger: "test", tasks: [task] });
    const after = await lastSuccesses([task.key]);
    assert("a success is remembered", after.has(task.key));

    await prismaSystem.scheduledTaskRun.deleteMany({ where: { taskKey: task.key } });
    const wiped = await lastSuccesses([task.key]);
    assert("and forgetting it makes the task due again, exactly as on a fresh deploy",
      !wiped.has(task.key) && isDue(task, wiped.get(task.key), new Date()));
  }

  console.log("\n--- the registry is coherent ---\n");
  {
    const keys = SCHEDULED_TASKS.map((t) => t.key);
    eq("every key is unique", keys.length, new Set(keys).size);
    for (const t of SCHEDULED_TASKS) {
      assert(`${t.key} declares a real interval`, t.everyMs > 0, `${t.everyMs}`);
      assert(`${t.key} declares a minimum useful budget`, t.minBudgetMs > 0, `${t.minBudgetMs}`);
      assert(`${t.key} declares an allowance`, t.maxBudgetMs > 0, `${t.maxBudgetMs}`);
      // A minimum larger than the allowance would mean a task that can be
      // started and is out of time the moment it begins.
      assert(`${t.key}'s allowance is at least its minimum`,
        t.maxBudgetMs >= t.minBudgetMs, `min ${t.minBudgetMs}, max ${t.maxBudgetMs}`);
      assert(`${t.key} says what it is for`, t.purpose.length > 20, t.purpose);
      assert(`${t.key} is in a known lane`, LANE_ORDER.includes(t.lane), t.lane);
      // A task must never claim more time than the trigger that runs it can
      // give, or it is permanently deferred and looks merely "not due".
      //
      // THIS ASSERTION WAS ONE STEP SHORT (2026-09-02). It asked whether each
      // task fits ALONE, which 180s and 240s both did against a 240s
      // invocation — and both of those tasks had nevertheless never run once,
      // because what actually matters is whether a task fits after the ones
      // ahead of it. Fitting alone is necessary and was never sufficient. The
      // cumulative check that closes the gap is below this loop.
      assert(`${t.key} fits inside a daily invocation's budget`, t.minBudgetMs <= 4 * MINUTE, `${t.minBudgetMs}`);
    }
    for (const lane of LANE_ORDER) {
      assert(`the ${lane} lane has at least one task`, tasksInLane(lane).length > 0);
    }
  }

  console.log("\n--- nothing the old route did was lost ---\n");
  {
    // ============ THE REFACTOR'S OWN SAFETY NET ====================
    //
    // Eleven responsibilities left a route handler. The worst outcome is not a
    // bug, it is one of them quietly ceasing to exist — which no test of the
    // new code would notice, because the new code would be entirely correct
    // about the ten it kept.
    const src = readFileSync("lib/scheduler/registry.ts", "utf8");
    const RESPONSIBILITIES: [string, string][] = [
      ["releaseStaleReplays", "webhooks.releaseStaleReplays"],
      ["sweepAbandonedTemporaries", "storage.temporaryAssets"],
      ["runNightlyReconciliation", "storage.reconcile"],
      ["runAttributionSweep", "storage.attributionSweep"],
      ["runDueOrderNotifications", "orders.notifications"],
      ["pruneExpiredAttempts", "auth.pruneAttempts"],
      ["runDueSyncs", "intelligence.syncs"],
      ["runDueGrowthPointRefreshes", "growthPoints.refresh"],
      ["runDueIntelligenceCycles", "intelligence.cycles"],
      ["runDueSourcing", "sourcing.discovery"],
      ["drain", "queue.drain"],
    ];
    for (const [fn, key] of RESPONSIBILITIES) {
      assert(`${fn} still runs, as ${key}`, !!taskByKey(key) && src.includes(`${fn}(`), key);
    }
    // WHAT WAS ADDED IS NAMED, never absorbed into a count. A refactor is
    // allowed to add something; it is not allowed to add something quietly, and
    // a bare length check would hide either.
    //
    //   telemetry.prune  the producer the inventory found missing — a registered
    //                    job kind with a handler that nothing enqueued.
    //   security.prune   added 2026-08-30. The security stream had no retention
    //                    at all and grew for ever, and its horizons differ
    //                    sharply by what a signal is for.
    //   ops.alerts       added 2026-08-30. needsAttention() and its scheduler
    //                    counterpart already computed the right answers and had
    //                    one caller each: a page somebody had to open.
    //   intelligence.aiReview
    //                    added 2026-09-02. NOT new work: it is the stage
    //                    that used to run inside intelligence.cycles,
    //                    lifted out after the first production tick
    //                    measured it at 98.7% of that task -- 206 of 209
    //                    seconds, six Opus calls. Named here because this
    //                    list's whole job is that nothing appears in the
    //                    registry without somebody saying why. See
    //                    BI_ENGINE.md section 17.
    const ADDED = ["telemetry.prune", "security.prune", "retention.sweep", "ops.alerts",
      "intelligence.aiReview"];
    // Sorted on both sides: this is about WHICH tasks were added, not the order
    // they happen to be declared in. A failure that only says "the same list in
    // a different order" is noise standing in front of the assertion that
    // matters — that nothing appeared without being named.
    eq("what was added is named, and nothing else appeared",
      SCHEDULED_TASKS.map((t) => t.key).filter((k) => !RESPONSIBILITIES.some(([, key]) => key === k)).sort(),
      [...ADDED].sort());
    eq("and nothing else appeared",
      SCHEDULED_TASKS.length, RESPONSIBILITIES.length + ADDED.length);

    // The weekly cadence used to be an if-statement inside a daily route.
    // COMMENTS STRIPPED FIRST: the first version of this matched the word
    // inside a comment explaining why the check is gone, and reported the
    // explanation as the offence.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    assert("the weekly sweep's cadence is an interval, not a day-of-week check",
      !code.includes("getUTCDay"), "getUTCDay is back in the registry's code");
    assert("and the registry says so in words too, so the next person knows why",
      src.includes("getUTCDay"), "the explanation was removed with the check");
    const route = readFileSync("app/api/cron/sync/route.ts", "utf8");
    assert("and the trigger decides nothing", !route.includes("getUTCDay"));
    assert("the trigger holds no business logic",
      !/runDue(Syncs|Sourcing|IntelligenceCycles|GrowthPointRefreshes)/.test(route));
    assert("it hands over to the scheduler", route.includes("runDueTasks("));
  }

  console.log("\n--- the queue finally has a producer for telemetry.prune ---\n");
  {
    // ============ A REGISTERED KIND WITH NO PRODUCER ===============
    //
    // The inventory found telemetry.prune had a handler, passed the registry
    // cross-check, and was enqueued by nothing anywhere — so retention had
    // never run and could not. The cross-check proves kinds match handlers; it
    // cannot prove a kind is ever produced.
    assert("telemetry.prune is a real job kind", (JOB_KINDS as readonly string[]).includes("telemetry.prune"));
    assert("and has a handler", !!HANDLERS["telemetry.prune"]);

    const task = taskByKey("telemetry.prune")!;
    await prismaSystem.job.deleteMany({ where: { kind: "telemetry.prune" } });
    await runDueTasks({ trigger: "test", only: "telemetry.prune", force: true });

    const jobs = await prismaSystem.job.findMany({ where: { kind: "telemetry.prune" } });
    eq("the task enqueues the prune", jobs.length, 1);
    assert("keyed by the day, so a frequent trigger cannot flood it",
      jobs[0].idempotencyKey.startsWith("telemetry.prune:"), jobs[0].idempotencyKey);

    // Twice in one day is once.
    await runDueTasks({ trigger: "test", only: "telemetry.prune", force: true });
    eq("running it again the same day adds nothing",
      await prismaSystem.job.count({ where: { kind: "telemetry.prune" } }), 1);

    eq("and it is maintenance, not a recompute", task.lane, "maintenance");
    await prismaSystem.job.deleteMany({ where: { kind: "telemetry.prune" } });
  }

  console.log("\n--- the real registry runs, through the real runner ---\n");
  {
    // Two tasks that are safe to actually invoke, so the registry and the
    // runner are exercised together and not only apart.
    for (const key of ["webhooks.releaseStaleReplays", "auth.pruneAttempts"]) {
      await prismaSystem.scheduledTaskRun.deleteMany({ where: { taskKey: key } });
      const result = await runDueTasks({ trigger: "test.real", only: key, force: true });
      eq(`${key} ran`, result.outcomes[0]?.status, "ran");
      const row = await prismaSystem.scheduledTaskRun.findFirst({ where: { taskKey: key } });
      eq(`${key} recorded a success`, row?.outcome, "succeeded");
    }
  }

  console.log("\n--- the scheduler can say whether it is running at all ---\n");
  {
    const now = new Date();
    const health = await schedulerHealth(now);
    eq("every task is reported", health.length, SCHEDULED_TASKS.length);
    assert("each carries its purpose", health.every((h) => h.purpose.length > 0));

    // ============ THE FAILURE THAT WAS UNDETECTABLE ================
    //
    // A cron that stops firing produces no rows anywhere. This is the only
    // check on the platform that can notice absence rather than describe
    // presence.
    const base = health.find((h) => h.key === "auth.pruneAttempts")!;
    const overdue = { ...base, enabled: true, lastSuccessAt: new Date(now.getTime() - 5 * DAY), overdueByMs: 4 * DAY };
    assert("an overdue task is a finding",
      schedulerNeedsAttention([overdue]).some((r) => r.includes("overdue")),
      JSON.stringify(schedulerNeedsAttention([overdue])));

    const stuck = { ...base, stuckSince: new Date(now.getTime() - 60 * MINUTE) };
    assert("a task that started and never finished is a finding",
      schedulerNeedsAttention([stuck]).some((r) => r.includes("never finished")));

    const failed = { ...base, enabled: true, lastOutcome: "failed" };
    assert("a task that failed its last run is a finding",
      schedulerNeedsAttention([failed]).some((r) => r.includes("failed")));

    // AND THE SILENCES, which matter as much. A page that cries about a task
    // switched off on purpose, or about a fresh deploy, is one nobody rereads.
    const off = { ...base, enabled: false, lastSuccessAt: null, lastOutcome: null, overdueByMs: null, stuckSince: null };
    eq("a task that is off by decision says nothing", schedulerNeedsAttention([off]), []);
    const fresh = { ...base, enabled: true, lastSuccessAt: null, lastOutcome: null, overdueByMs: null, stuckSince: null };
    eq("a task that has never run yet says nothing", schedulerNeedsAttention([fresh]), []);
  }

  console.log("\n--- an operator can ask what a trigger would do right now ---\n");
  {
    const due = await dueNow(["queue", "timely"]);
    assert("the frequent lanes report what is due",
      Array.isArray(due) && due.every((k) => {
        const t = taskByKey(k);
        return t && (["queue", "timely"] as Lane[]).includes(t.lane);
      }), JSON.stringify(due));
  }

  console.log("\n--- the frequent trigger exists and is deliberately not scheduled ---\n");
  {
    // ============ BUILT, PROVEN, AND OFF ===========================
    //
    // The queue's only runner is a daily cron, which is the whole of Rank 3. A
    // second entry needs a paid plan, and Sean: do not turn a paid-infrastructure
    // requirement into a fake local solution. So the application half is real and
    // the schedule is absent — and this asserts BOTH halves of that sentence, so
    // "we built it and left it off" cannot quietly become "we forgot".
    const tick = readFileSync("app/api/cron/tick/route.ts", "utf8");
    assert("the frequent trigger is authorized like every cron route",
      tick.includes("isAuthorizedCronRequest"));
    assert("it runs only the lanes whose delay somebody feels",
      /FREQUENT_LANES[\s\S]{0,80}"queue",\s*"timely"/.test(tick));
    // THE INVOCATION'S budget, not a task's minimum — two different numbers
    // that briefly got the same name during the 2026-09-02 rename, and this
    // assertion is what noticed.
    assert("and its budget is well inside its own interval",
      /[^a-zA-Z]budgetMs:\s*90_000/.test(tick), "a trigger that can outlast its interval overlaps itself");

    const vercel = JSON.parse(readFileSync("vercel.json", "utf8")) as { crons?: { path: string }[] };
    const paths = (vercel.crons ?? []).map((c) => c.path);
    eq("exactly one schedule is switched on", paths, ["/api/cron/sync"]);
    assert("and the frequent one is NOT", !paths.includes("/api/cron/tick"));
  }

  console.log(`\n${failures} failed, ${passes} passed\n`);
  await prismaSystem.$disconnect();
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
