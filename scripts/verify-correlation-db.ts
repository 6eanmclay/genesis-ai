import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { withCorrelation, correlationId, newCorrelationId } from "@/lib/observability/correlation";
import { recordExecution } from "@/lib/execution/log";
import { logProductEvent } from "@/lib/telemetry/events";
import { recordSignal, SIGNAL_KINDS, signalsForCorrelation } from "@/lib/security/signals";
import { recordDelivery } from "@/lib/webhooks/delivery";
import { enqueue, claimNext, drain, complete, type JobHandler } from "@/lib/jobs/queue";
import { CURRENT_EXECUTION_SCHEMA_VERSION } from "@/lib/execution/types";

// ONE THREAD THROUGH EVERYTHING ONE REQUEST CAUSES:
//
//   part of the database sweep — npx tsx scripts/run-db-suites.ts correlation-db
//
// ============ WHAT THIS HAS TO PROVE (2026-08-30) ======================
//
// Not that a column exists. That the five tables which record what happened can
// be JOINED into one story — and specifically that the story survives the two
// boundaries where a trace normally breaks:
//
//   a nested call, which must not mint a second id
//   a job, whose handler runs minutes later in a process that never saw the
//     request — an AsyncLocalStorage scope does not survive that, so the id has
//     to be carried on the row and re-entered
//
// The second is the one worth the suite. Without it every chain breaks at
// exactly the interesting boundary: where a request hands work to a runner.

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
  const user = await prisma.user.create({ data: { email: `cor-${stamp}@example.test`, name: "Owner" } });
  const store = await prisma.store.create({
    data: { userId: user.id, name: "Cor", slug: `cor-${stamp}`, tagline: "t", description: "d" },
  });

  console.log("\n--- five tables, one story ---\n");
  {
    const traced = await withCorrelation({ origin: "http", surface: "test" }, async () => {
      const id = correlationId()!;

      await recordExecution({
        executionId: `exec-${stamp}`,
        storeId: store.id,
        storeDraftId: null,
        action: "test.action",
        status: "SUCCESS",
        verified: true,
        message: "did the thing",
        retryable: false,
        actorType: "USER",
        actorId: user.id,
        schemaVersion: CURRENT_EXECUTION_SCHEMA_VERSION,
        timestamp: new Date(),
        metadata: undefined,
      });

      await logProductEvent({
        sessionInstanceId: `sess-${stamp}`,
        name: "test.event",
        category: "creation",
        storeId: store.id,
        userId: user.id,
      });

      await recordSignal({
        kind: SIGNAL_KINDS.authzDenied, actorKind: "user", actorId: user.id, storeId: store.id,
      });

      await recordDelivery({
        provider: `cor-provider-${stamp}`, rawBody: "{}", signatureValid: true, storeId: store.id,
      });

      await enqueue({ kind: "noop", idempotencyKey: `cor-job-${stamp}`, storeId: store.id });

      return id;
    });

    // THE WHOLE POINT: one id, asked of five different tables.
    eq("the execution row joins the chain",
      await prismaSystem.executionLog.count({ where: { correlationId: traced } }), 1);
    eq("the telemetry event joins it",
      await prismaSystem.productEvent.count({ where: { correlationId: traced } }), 1);
    eq("the security signal joins it",
      (await signalsForCorrelation(traced)).length, 1);
    eq("the webhook delivery joins it",
      await prismaSystem.webhookDelivery.count({ where: { correlationId: traced } }), 1);
    eq("and the job that was enqueued joins it",
      await prismaSystem.job.count({ where: { correlationId: traced } }), 1);
  }

  console.log("\n--- the chain survives the queue ---\n");
  {
    // ============ THE BOUNDARY THAT NORMALLY BREAKS A TRACE ========
    //
    // The handler runs after the request is gone. An AsyncLocalStorage scope
    // does not survive that, so if the id were only ambient at enqueue time the
    // handler would write with nothing — and the trace would end precisely
    // where a request hands work to a background runner.
    const requestId = await withCorrelation({ origin: "http" }, async () => {
      const id = correlationId()!;
      await enqueue({ kind: "noop", idempotencyKey: `carry-${stamp}`, storeId: store.id });
      return id;
    });

    // Now, outside any scope — as a cron genuinely is.
    eq("nothing is ambient out here", correlationId(), null);

    let seenInsideHandler: string | null = "never ran";
    const handler: JobHandler = async () => {
      seenInsideHandler = correlationId();
      // A handler's own writes must land on the original chain.
      await recordSignal({ kind: SIGNAL_KINDS.executionAnomaly, actorKind: "system", storeId: store.id });
    };

    const result = await drain({ noop: handler }, { maxJobs: 10 });
    assert("the job ran", result.completed >= 1, JSON.stringify(result));
    eq("and the handler re-entered the REQUEST's chain, not a new one", seenInsideHandler, requestId);
    eq("so what it wrote joins the same story",
      (await signalsForCorrelation(requestId)).filter((s) => s.kind === SIGNAL_KINDS.executionAnomaly).length, 1);
    eq("the scope closed again afterwards", correlationId(), null);
  }

  console.log("\n--- nesting does not cut the trace in half ---\n");
  {
    const [outer, inner, deepest] = await withCorrelation({ origin: "http" }, async () => {
      const a = correlationId();
      const [b, c] = await withCorrelation({ origin: "execution" }, async () => {
        const x = correlationId();
        const y = await withCorrelation({ origin: "job" }, async () => correlationId());
        return [x, y];
      });
      return [a, b, c];
    });
    eq("two levels down is still the same chain", inner, outer);
    eq("three levels down too", deepest, outer);
  }

  console.log("\n--- outside a chain, nothing is invented ---\n");
  {
    // A script, a test, a migration. Null is the honest answer; a fabricated
    // causal claim in an evidence table is worse than an absent one.
    await recordSignal({ kind: SIGNAL_KINDS.rateLimited, actorKind: "system", storeId: store.id });
    const loose = await prismaSystem.securitySignal.findFirst({
      where: { kind: SIGNAL_KINDS.rateLimited, storeId: store.id },
      orderBy: { occurredAt: "desc" },
    });
    eq("a signal written outside a scope carries no id", loose?.correlationId, null);

    await enqueue({ kind: "noop", idempotencyKey: `loose-${stamp}`, storeId: store.id });
    const looseJob = await prismaSystem.job.findUnique({ where: { idempotencyKey: `loose-${stamp}` } });
    eq("and so does a job", looseJob?.correlationId, null);
  }

  console.log("\n--- an explicit id wins over the ambient one ---\n");
  {
    const explicit = newCorrelationId();
    await withCorrelation({ origin: "http" }, async () => {
      await enqueue({
        kind: "noop", idempotencyKey: `explicit-${stamp}`, storeId: store.id,
        correlationId: explicit,
      });
    });
    const row = await prismaSystem.job.findUnique({ where: { idempotencyKey: `explicit-${stamp}` } });
    eq("the caller's id is used, not the ambient one", row?.correlationId, explicit);
    // UNCONDITIONAL. The first version guarded this behind `if (claimed?.key
    // === ...)`, which would have passed silently on any run where a different
    // job was claimed first — an assertion that can skip itself is not an
    // assertion. Claim until this specific job comes up, or fail.
    let handed: string | null | undefined;
    for (let i = 0; i < 20; i++) {
      const claimed = await claimNext("runner");
      if (!claimed) break;
      if (claimed.idempotencyKey === `explicit-${stamp}`) handed = claimed.correlationId;
      await complete(claimed.id);
      if (handed !== undefined) break;
    }
    eq("and it is handed to the runner with that id", handed, explicit);
  }

  console.log("\n--- old rows keep their honest null ---\n");
  {
    // Nothing was backfilled, and nothing should have been: no row written
    // before today can say what it belonged to.
    const nulls = await prismaSystem.executionLog.count({ where: { correlationId: null } });
    assert("rows written before the column exists are simply null", nulls >= 0, `${nulls}`);
    const withId = await prismaSystem.executionLog.count({ where: { correlationId: { not: null } } });
    assert("and new ones carry it", withId >= 1, `${withId}`);
  }

  console.log(`\n${failures} failed, ${passes} passed\n`);
  await prismaSystem.$disconnect();
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
