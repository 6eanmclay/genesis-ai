import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { RETENTION, policyFor, awaitingDecision, daysAgo } from "@/lib/retention/policy";
import { runRetentionSweep, retentionFootprint, MAX_PER_RUN } from "@/lib/retention/sweep";
import { JOB_KINDS, HANDLERS, validateJobPayload } from "@/lib/jobs/registry";
import { taskByKey } from "@/lib/scheduler/registry";
import { readFileSync } from "node:fs";

// WHAT GROWS FOREVER, AND WHAT MAY BE DONE ABOUT IT:
//
//   part of the database sweep — npx tsx scripts/run-db-suites.ts retention-db
//
// ============ THE TABLE THAT MATTERED MOST (2026-08-30) ================
//
// WebhookDelivery stores every provider payload verbatim — customer names,
// email addresses, postal addresses, amounts — kept indefinitely, for a reason
// that expired the moment the delivery was handled.
//
// Deleting the rows would have been the obvious move and the wrong one. The
// row is the audit trail: which provider, which event, did the signature
// verify, what happened. The BODY is what a customer would mind us keeping. So
// the body goes and the record stays, and most of this file is about proving
// that distinction holds in both directions.
//
// ============ AND THE VERDICT THAT DOES NOTHING =======================
//
// Sean: "Do not silently delete security/audit information based on an
// arbitrary assumption." Five tables hold audit, financial or product-memory
// data whose horizon is a legal or product question. They carry a `decide`
// verdict, the sweep reports them untouched and says whose question it is, and
// this suite asserts they are never written to. A table nobody has decided
// about must not be quietly emptied by a maintenance job.

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
  const user = await prisma.user.create({ data: { email: `rt-${stamp}@example.test` } });
  const store = await prisma.store.create({
    data: { userId: user.id, name: "RT", slug: `rt-${stamp}`, tagline: "t", description: "d" },
  });

  const CUSTOMER_DATA = `{"email":"buyer-${stamp}@example.test","address":"12 Real Street"}`;

  console.log("\n--- the policy names every growing table and its verdict ---\n");
  {
    for (const policy of RETENTION) {
      assert(`${policy.model} says what it holds`, policy.holds.length > 30, policy.holds);
      assert(`${policy.model} says why`, policy.reasoning.length > 60, policy.reasoning.slice(0, 60));
      if (policy.verdict === "decide") {
        // ============ A REFUSAL MUST NAME ITS QUESTION =========
        //
        // Otherwise "decide" is indistinguishable from "forgot".
        assert(`${policy.model} names whose decision it is`, !!policy.needs && policy.needs.length > 20,
          policy.needs ?? "(none)");
        eq(`${policy.model} has no invented horizon`, policy.keepDays, null);
      } else {
        assert(`${policy.model} has a horizon`, (policy.keepDays ?? 0) > 0, `${policy.keepDays}`);
      }
    }
    assert("five tables are deliberately undecided", awaitingDecision().length === 5,
      `${awaitingDecision().length}`);
    // The audit trail is one of them, explicitly.
    eq("the execution log is not pruned on a guess", policyFor("executionLog")?.verdict, "decide");
    eq("nor is the idempotency record", policyFor("outboundOperation")?.verdict, "decide");
  }

  console.log("\n--- a handled delivery loses its body and keeps its record ---\n");
  {
    const old = await prismaSystem.webhookDelivery.create({
      data: {
        provider: `rt-${stamp}`, externalEventId: `evt-old-${stamp}`, storeId: store.id,
        status: "processed", signatureValid: true, payload: CUSTOMER_DATA,
        receivedAt: daysAgo(60), attempts: 1,
      },
    });

    const dry = await runRetentionSweep({ apply: false });
    const dryDelivery = dry.tables.find((t) => t.model === "webhookDelivery")!;
    assert("a dry run says what would go", dryDelivery.wouldAffect > 0, `${dryDelivery.wouldAffect}`);
    eq("and changes nothing", dryDelivery.affected, 0);
    eq("the payload is still there after a dry run",
      (await prismaSystem.webhookDelivery.findUnique({ where: { id: old.id } }))?.payload, CUSTOMER_DATA);

    await runRetentionSweep({ apply: true });
    const after = await prismaSystem.webhookDelivery.findUnique({ where: { id: old.id } });

    // ============ THE POINT OF THE WHOLE ITEM ==============
    assert("the customer data is gone", after?.payload === "", `payload was ${after?.payload?.slice(0, 40)}`);
    // And the evidence is not.
    assert("but the row is still there", !!after);
    eq("with which provider", after?.provider, `rt-${stamp}`);
    eq("which event", after?.externalEventId, `evt-old-${stamp}`);
    eq("whether it was signed", after?.signatureValid, true);
    eq("and what happened to it", after?.status, "processed");
    assert("and when", !!after?.receivedAt);
  }

  console.log("\n--- a failed delivery keeps its body, whatever its age ---\n");
  {
    // ============ REDACTING THIS WOULD DESTROY A RECOVERY ====
    //
    // The bytes are what a replay runs on. Clearing them would turn a
    // recoverable failure into a permanent one — quietly, months later, in the
    // one place somebody would go looking for a lost order.
    const failed = await prismaSystem.webhookDelivery.create({
      data: {
        provider: `rt-${stamp}`, externalEventId: `evt-failed-${stamp}`, storeId: store.id,
        status: "failed", signatureValid: true, payload: CUSTOMER_DATA,
        receivedAt: daysAgo(400), attempts: 3, error: "the handler refused it",
      },
    });
    const replaying = await prismaSystem.webhookDelivery.create({
      data: {
        provider: `rt-${stamp}`, externalEventId: `evt-replaying-${stamp}`, storeId: store.id,
        status: "replaying", signatureValid: true, payload: CUSTOMER_DATA,
        receivedAt: daysAgo(400), attempts: 1,
      },
    });

    await runRetentionSweep({ apply: true });

    eq("a failed delivery from over a year ago keeps its body",
      (await prismaSystem.webhookDelivery.findUnique({ where: { id: failed.id } }))?.payload, CUSTOMER_DATA);
    eq("and so does one being replayed right now",
      (await prismaSystem.webhookDelivery.findUnique({ where: { id: replaying.id } }))?.payload, CUSTOMER_DATA);

    // A rejected one has no future — its signature never verified, so it can
    // never be replayed and the body serves nothing.
    const rejected = await prismaSystem.webhookDelivery.create({
      data: {
        provider: `rt-${stamp}`, externalEventId: `evt-rejected-${stamp}`,
        status: "rejected", signatureValid: false, payload: CUSTOMER_DATA,
        receivedAt: daysAgo(60), attempts: 1,
      },
    });
    await runRetentionSweep({ apply: true });
    eq("a rejected delivery does lose its body",
      (await prismaSystem.webhookDelivery.findUnique({ where: { id: rejected.id } }))?.payload, "");
  }

  console.log("\n--- a recent delivery is untouched ---\n");
  {
    const recent = await prismaSystem.webhookDelivery.create({
      data: {
        provider: `rt-${stamp}`, externalEventId: `evt-recent-${stamp}`, storeId: store.id,
        status: "processed", signatureValid: true, payload: CUSTOMER_DATA,
        receivedAt: daysAgo(2), attempts: 1,
      },
    });
    await runRetentionSweep({ apply: true });
    eq("two days old keeps everything",
      (await prismaSystem.webhookDelivery.findUnique({ where: { id: recent.id } }))?.payload, CUSTOMER_DATA);
  }

  console.log("\n--- operational rows are pruned, with their exemptions ---\n");
  {
    const done = await prismaSystem.job.create({
      data: { kind: "noop", idempotencyKey: `rt-done-${stamp}`, status: "done",
        createdAt: daysAgo(60), completedAt: daysAgo(60) },
    });
    // ============ A DEAD LETTER IS UNFINISHED BUSINESS ======
    //
    // The only record of work that gave up. Deleting one erases something
    // nobody has yet decided what to do about.
    const dead = await prismaSystem.job.create({
      data: { kind: "noop", idempotencyKey: `rt-dead-${stamp}`, status: "dead",
        createdAt: daysAgo(400), attempts: 5, lastError: "gave up" },
    });
    const pending = await prismaSystem.job.create({
      data: { kind: "noop", idempotencyKey: `rt-pending-${stamp}`, status: "pending",
        createdAt: daysAgo(400) },
    });

    const oldRun = await prismaSystem.scheduledTaskRun.create({
      data: { taskKey: "auth.pruneAttempts", outcome: "succeeded", startedAt: daysAgo(60) },
    });
    // A run still `running` after a year is a process that died mid-task —
    // the finding, not the noise.
    const stuck = await prismaSystem.scheduledTaskRun.create({
      data: { taskKey: "auth.pruneAttempts", outcome: "running", startedAt: daysAgo(400) },
    });

    await runRetentionSweep({ apply: true });

    const alive = async (t: "job" | "run", id: string) =>
      t === "job"
        ? (await prismaSystem.job.count({ where: { id } })) === 1
        : (await prismaSystem.scheduledTaskRun.count({ where: { id } })) === 1;

    assert("a completed job past its horizon is removed", !(await alive("job", done.id)));
    assert("a dead letter survives, whatever its age", await alive("job", dead.id));
    assert("and so does work that has not run yet", await alive("job", pending.id));
    assert("an old scheduled run is removed", !(await alive("run", oldRun.id)));
    assert("but one stuck mid-run survives", await alive("run", stuck.id));
  }

  console.log("\n--- the undecided tables are never touched ---\n");
  {
    // ============ THE INSTRUCTION, AS AN ASSERTION ==========
    const execution = await prismaSystem.executionLog.count();
    const outbound = await prismaSystem.outboundOperation.count();
    const usage = await prismaSystem.aiUsageEvent.count();
    const events = await prismaSystem.businessEvent.count();

    const result = await runRetentionSweep({ apply: true });

    eq("the execution log is unchanged", await prismaSystem.executionLog.count(), execution);
    eq("the idempotency record is unchanged", await prismaSystem.outboundOperation.count(), outbound);
    eq("cost history is unchanged", await prismaSystem.aiUsageEvent.count(), usage);
    eq("and the event pipeline is unchanged", await prismaSystem.businessEvent.count(), events);

    // Reported rather than silently skipped, so the sweep's own output names
    // what it is refusing to do.
    for (const model of ["executionLog", "outboundOperation", "aiUsageEvent", "businessEvent", "cognitiveOutput"]) {
      const row = result.tables.find((t) => t.model === model);
      eq(`${model} is reported as awaiting a decision`, row?.verdict, "decide");
      assert(`${model} says whose decision`, (row?.skipped ?? "").length > 20, row?.skipped ?? "");
      eq(`${model} affected nothing`, row?.affected, 0);
    }
  }

  console.log("\n--- bounded, idempotent, and honest about stopping ---\n");
  {
    const again = await runRetentionSweep({ apply: true });
    const total = again.tables.reduce((n, t) => n + t.affected, 0);
    eq("running it twice changes nothing the second time", total, 0);
    eq("there is a default cap", MAX_PER_RUN, 5_000);

    for (let i = 0; i < 5; i++) {
      await prismaSystem.scheduledTaskRun.create({
        data: { taskKey: "auth.pruneAttempts", outcome: "succeeded", startedAt: daysAgo(90) },
      });
    }
    const capped = await runRetentionSweep({ apply: true, maxPerRun: 2 });
    const runs = capped.tables.find((t) => t.model === "scheduledTaskRun")!;
    eq("a capped run removes at most its cap", runs.affected, 2);
    assert("and says there is more", runs.moreRemaining);
  }

  console.log("\n--- an operator can see what is held before switching it on ---\n");
  {
    const footprint = await retentionFootprint();
    eq("every policy is reported", footprint.length, RETENTION.length);
    const delivery = footprint.find((f) => f.model === "webhookDelivery")!;
    eq("with its verdict", delivery.verdict, "redact");
    eq("and its horizon", delivery.keepDays, 30);
    assert("and a total", typeof delivery.total === "number");
  }

  console.log("\n--- it is queued, scheduled, and dry by default ---\n");
  {
    assert("retention.sweep is a real job kind",
      (JOB_KINDS as readonly string[]).includes("retention.sweep"));
    assert("with a handler", !!HANDLERS["retention.sweep"]);
    eq("and a validated payload",
      validateJobPayload("retention.sweep", { apply: true, maxPerRun: 10 }), { ok: true });

    const task = taskByKey("retention.sweep");
    assert("a task produces the work", !!task);
    assert("switched on", !!task?.enabled());

    // ============ DRY BY DEFAULT, BECAUSE IT CLEARS CUSTOMER DATA ==
    const registry = readFileSync("lib/scheduler/registry.ts", "utf8");
    const block = registry.slice(registry.indexOf('key: "retention.sweep"'), registry.indexOf('key: "security.prune"'));
    assert("the producer sends no apply flag", !/apply:\s*true/.test(block), block.slice(0, 200));
    const handler = readFileSync("lib/jobs/registry.ts", "utf8");
    assert("and the handler defaults to a dry run",
      /runRetentionSweep\(\{ apply: payload\.apply === true/.test(handler));

    // The default in the sweep itself, not only in its callers.
    const beforeCount = await prismaSystem.scheduledTaskRun.count();
    await prismaSystem.scheduledTaskRun.create({
      data: { taskKey: "auth.pruneAttempts", outcome: "succeeded", startedAt: daysAgo(90) },
    });
    await runRetentionSweep({});
    eq("calling it with no options deletes nothing",
      await prismaSystem.scheduledTaskRun.count(), beforeCount + 1);
  }

  console.log(`\n${failures} failed, ${passes} passed\n`);
  await prismaSystem.$disconnect();
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
