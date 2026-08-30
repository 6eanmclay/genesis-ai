import "@/scripts/lib/allowServerOnly";

import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { runAlertSweep, COOLDOWN_MS } from "@/lib/observability/alerts";
import { needsAttention } from "@/lib/admin/platformHealth";
import { schedulerNeedsAttention } from "@/lib/scheduler/health";
import { taskByKey } from "@/lib/scheduler/registry";
import { runDueTasks } from "@/lib/scheduler/run";
import { readFileSync } from "node:fs";

// SAYING SOMETHING, ONCE:
//
//   part of the database sweep — npx tsx scripts/run-db-suites.ts alerts-db
//
// ============ WHAT WAS ACTUALLY MISSING (2026-08-30) ==================
//
// Not a destination. Sentry is wired, its DSN is set in production, reportIssue
// redacts and sends to it, and thirty-three modules already call it. An earlier
// inventory said "nothing reaches a person" and that was wrong.
//
// What was missing is that EXCEPTIONS reach Sentry and the failures this
// platform actually has are not exceptions. A dead-lettered job, an operation
// with an unknown outcome, a scheduled task that stopped firing — none of those
// throw. They are conditions found by asking, and the only thing that asked was
// a page somebody had to open.
//
// ============ SO THE HARD PART IS SAYING IT ONCE ======================
//
// These conditions persist. A dead letter is still dead an hour later, and an
// alert that repeats every hour is one somebody mutes — which leaves the
// platform worse off than silence, because now there is a channel everybody
// ignores.
//
// Most of this file is therefore about restraint: proving a finding is reported
// once, that a WORSE version of it is reported again, and that a healthy
// platform produces nothing at all.

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

async function main(): Promise<void> {
  await requireTestDatabase(prismaSystem);
  const stamp = Date.now();

  console.log("\n--- a healthy platform says nothing at all ---\n");
  {
    // ============ THE SILENCE IS THE FEATURE ==================
    //
    // needsAttention is deliberately narrow and nothing here widens it. A
    // heartbeat that fires when all is well is the same noise problem wearing a
    // friendlier name.
    const quiet = {
      generatedAt: new Date().toISOString(),
      queue: { depth: { pending: 4, running: 1, done: 900, dead: 0 }, deadLetters: [], stalled: 0 },
      indeterminate: [],
      webhooks: { health: [], replayable: 0 },
      security: [{ kind: "authz.denied", severity: "warning", count: 3, lastSeenAt: new Date() }],
      telemetry: { total: 5000, oldest: new Date(), byName: [] },
      scheduler: [{
        key: "queue.drain", lane: "queue" as const, purpose: "drain", enabled: true,
        everyMs: 120_000, lastSuccessAt: new Date(), lastOutcome: "succeeded",
        lastDurationMs: 12, overdueByMs: null, stuckSince: null,
      }],
    };
    eq("a busy, working platform raises nothing", needsAttention(quiet), []);
    eq("and a scheduler on time raises nothing", schedulerNeedsAttention(quiet.scheduler), []);
  }

  console.log("\n--- a real finding is reported exactly once ---\n");
  {
    // A dead-lettered job is a genuine finding, planted the way one occurs.
    const user = await prisma.user.create({ data: { email: `al-${stamp}@example.test` } });
    const store = await prisma.store.create({
      data: { userId: user.id, name: "AL", slug: `al-${stamp}`, tagline: "t", description: "d" },
    });
    await prismaSystem.job.create({
      data: {
        kind: "noop", idempotencyKey: `al-dead-${stamp}`, storeId: store.id,
        status: "dead", attempts: 5, lastError: "gave up",
      },
    });

    // ============ WATCH THE DISPATCH, NOT THE BOOKKEEPING ====
    //
    // This asserted `outcome.reported`, which the sweep fills in itself — so
    // sabotage disabled the reportIssue call entirely and the suite stayed
    // green, because the array was still being appended to. reportIssue always
    // writes a console line, so capturing that observes the real dispatch
    // without injecting anything in place of it.
    const said: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => { said.push(args.map(String).join(" ")); };
    let first: Awaited<ReturnType<typeof runAlertSweep>>;
    try {
      first = await runAlertSweep();
    } finally {
      console.error = realError;
    }
    assert("the dead letter is found", first.findings.some((f) => f.includes("gave up")),
      JSON.stringify(first.findings));
    assert("and reported", first.reported.some((f) => f.includes("gave up")));
    assert("and genuinely dispatched, not merely recorded as sent",
      said.some((line) => line.includes("gave up")), JSON.stringify(said).slice(0, 200));

    // ============ AND NOT AGAIN ==============================
    //
    // The condition is still true. Saying so a second time is how a channel
    // becomes noise.
    const second = await runAlertSweep();
    assert("the same finding is still true", second.findings.some((f) => f.includes("gave up")));
    assert("but is not reported again", !second.reported.some((f) => f.includes("gave up")),
      JSON.stringify(second.reported));
    assert("and is counted as suppressed", second.suppressed > 0, `${second.suppressed}`);

    // ============ UNLESS IT GETS WORSE =======================
    //
    // The fingerprint includes the count, so a condition deteriorating is news
    // while a condition merely continuing is not.
    await prismaSystem.job.create({
      data: {
        kind: "noop", idempotencyKey: `al-dead2-${stamp}`, storeId: store.id,
        status: "dead", attempts: 5, lastError: "gave up too",
      },
    });
    const worse = await runAlertSweep();
    assert("a worsening count is reported again",
      worse.reported.some((f) => f.includes("2 job(s) gave up")),
      JSON.stringify(worse.reported));
  }

  console.log("\n--- a stalled scheduled task is a finding too ---\n");
  {
    // ============ THE SECOND SOURCE, PLANTED ==================
    //
    // Sabotage dropped every scheduler finding and the suite stayed green,
    // because nothing here had ever produced one. A task that started and never
    // finished is the shape of a process killed mid-run, and it is the failure
    // that makes every other check look healthy — nothing is generating new
    // work to be behind on.
    //
    // Keyed to a REAL task, because schedulerHealth reports the registry: a row
    // under an invented key maps to nothing and would have been another test
    // that could not fail.
    await prismaSystem.scheduledTaskRun.create({
      data: {
        taskKey: "auth.pruneAttempts", outcome: "running",
        startedAt: new Date(Date.now() - 60 * 60 * 1000),
        trigger: "test",
      },
    });
    const outcome = await runAlertSweep();
    assert("a task that never finished is found",
      outcome.findings.some((f) => f.includes("never finished")),
      JSON.stringify(outcome.findings));
    await prismaSystem.scheduledTaskRun.deleteMany({
      where: { taskKey: "auth.pruneAttempts", outcome: "running" },
    });
  }


  console.log("\n--- the cooldown is long enough to be quiet ---\n");
  {
    // Six hours. Short enough that a fixed problem stops being reported the
    // same day; long enough that a persistent one is not a drumbeat.
    eq("the cooldown is six hours", COOLDOWN_MS, 6 * 60 * 60 * 1000);
  }

  console.log("\n--- it reaches the destination that already exists ---\n");
  {
    // ============ ONE DISPATCHER, NOT A SECOND ================
    //
    // reportIssue is the only path that redacts and reaches Sentry. A second
    // dispatcher here would be a second answer to "how does an operator hear
    // about this" — and the one that drifted would be the one nobody read.
    const src = readFileSync("lib/observability/alerts.ts", "utf8");
    assert("findings go through reportIssue", src.includes("reportIssue("));
    assert("and nothing else sends anything",
      !/fetch\(|sendEmail|Resend|axios/.test(src), "a second dispatcher appeared");

    // reportIssue redacts on the way out — asserted where it lives, so this
    // depends on it rather than restating it.
    const reporter = readFileSync("lib/observability/reportIssue.ts", "utf8");
    assert("and that path redacts secrets", reporter.includes("redactSecrets("));
  }

  console.log("\n--- it is scheduled, not left to somebody remembering ---\n");
  {
    const task = taskByKey("ops.alerts");
    assert("the sweep is a scheduled task", !!task, "not in the scheduler registry");
    assert("switched on", !!task?.enabled());
    assert("running at least hourly", (task?.everyMs ?? Infinity) <= 60 * 60 * 1000, `${task?.everyMs}`);
    eq("in the maintenance lane, not the timely one", task?.lane, "maintenance");

    // And it genuinely runs through the real runner.
    await prismaSystem.scheduledTaskRun.deleteMany({ where: { taskKey: "ops.alerts" } });
    const result = await runDueTasks({ trigger: "test.alerts", only: "ops.alerts", force: true });
    eq("it runs", result.outcomes[0]?.status, "ran");
    const row = await prismaSystem.scheduledTaskRun.findFirst({ where: { taskKey: "ops.alerts" } });
    eq("and records a success", row?.outcome, "succeeded");
  }

  console.log("\n--- a broken health read does not break the sweep ---\n");
  {
    // ============ THE MONITOR MUST NOT BE THE OUTAGE ==========
    //
    // This runs from the scheduler. An alerting mechanism that can crash the
    // thing it monitors is worse than none, so both reads are caught
    // independently and the sweep still answers.
    // ============ PROVEN BY MAKING ONE FAIL ===================
    //
    // This used to check the source for a try/catch, which sabotage walked
    // straight past: restructuring the catch changed nothing observable,
    // because nothing was throwing. A source that genuinely throws is the only
    // way to find out whether the sweep survives it.
    const broken = await runAlertSweep({
      sources: [
        { name: "explodes", read: async () => { throw new Error("health is unreadable"); } },
        { name: "works", read: async () => [`al-still-works-${stamp}`] },
      ],
    });
    assert("the sweep answers despite a failing source", Array.isArray(broken.findings));
    // AND THE OTHER SOURCE IS NOT LOST. The likelier accident than a crash: one
    // failure quietly swallowing the findings of everything after it.
    assert("and the working source is still read",
      broken.findings.includes(`al-still-works-${stamp}`), JSON.stringify(broken.findings));

    // ============ ONE SOURCE, AND THAT IS THE POINT ===========
    //
    // There were two, and sabotage proved the second was redundant: dropping it
    // changed nothing, because platformHealth already carries scheduler health
    // and needsAttention already asks about it. A duplicate no test could
    // notice being removed is a duplicate nothing was testing.
    const { defaultSources } = await import("@/lib/observability/alerts");
    eq("one real source is registered, not two",
      defaultSources().map((s) => s.name), ["platformHealth"]);
    // And it genuinely still carries scheduler findings — proven above by the
    // stalled task, which reaches the sweep through this single source.

    const outcome = await runAlertSweep();
    assert("and the real sweep always answers", Array.isArray(outcome.findings));
  }

  console.log(`\n${failures} failed, ${passes} passed\n`);
  await prismaSystem.$disconnect();
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
