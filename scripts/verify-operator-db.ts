import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { platformHealth, needsAttention } from "@/lib/admin/platformHealth";
import { traceFor, recentTraces } from "@/lib/admin/trace";
import { withCorrelation, correlationId } from "@/lib/observability/correlation";
import { recordExecution } from "@/lib/execution/log";
import { recordDelivery, markFailed } from "@/lib/webhooks/delivery";
import { recordSignal, SIGNAL_KINDS } from "@/lib/security/signals";
import { enqueue } from "@/lib/jobs/queue";
import { runOnce, CLAIM_TTL_MS } from "@/lib/outbound/runOnce";
import { emit } from "@/lib/telemetry/emit";
import { CURRENT_EXECUTION_SCHEMA_VERSION } from "@/lib/execution/types";

// THE OPERATOR SURFACES:
//
//   part of the database sweep — npx tsx scripts/run-db-suites.ts operator-db
//
// ============ WHAT NEEDED PROVING (2026-08-30) =========================
//
// Two things, and neither is "a number was returned".
//
// That the trace ASSEMBLES SIX SOURCES into one timeline — because the whole
// point of Item 1 was that an incident could not be reconstructed, and a viewer
// that quietly reads five of six would recreate the gap while looking closed.
//
// And that "needs attention" is NARROW. A health check that raises a flag over
// routine traffic is one nobody trusts twice, so the assertions below insist it
// stays silent on a healthy platform and speaks on exactly the four states that
// mean somebody should act.

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
  const user = await prisma.user.create({ data: { email: `op-${stamp}@example.test`, name: "Owner" } });
  const store = await prisma.store.create({
    data: { userId: user.id, name: "OP", slug: `op-${stamp}`, tagline: "t", description: "d" },
  });

  console.log("\n--- one chain, assembled from all six sources ---\n");
  {
    const traced = await withCorrelation({ origin: "http", surface: "test" }, async () => {
      const id = correlationId()!;

      await recordDelivery({
        provider: `op-${stamp}`, rawBody: '{"id":"evt_op"}', signatureValid: true,
        externalEventId: `evt_op_${stamp}`, storeId: store.id,
      });
      await recordExecution({
        executionId: `op-exec-${stamp}`, storeId: store.id, storeDraftId: null,
        action: "op.action", status: "FAILED", verified: false,
        message: "it did not work", retryable: true, actorType: "GENESIS", actorId: null,
        schemaVersion: CURRENT_EXECUTION_SCHEMA_VERSION, timestamp: new Date(), metadata: undefined,
      });
      await runOnce({
        key: `op-out-${stamp}`, operation: "op.effect", storeId: store.id,
        perform: async () => ({ result: { ok: true }, externalRef: "OP-1" }),
      });
      await enqueue({ kind: "noop", idempotencyKey: `op-job-${stamp}`, storeId: store.id });
      await recordSignal({ kind: SIGNAL_KINDS.authzDenied, actorKind: "user", actorId: user.id, storeId: store.id });
      await emit({ name: "execution.completed", actorKind: "genesis", storeId: store.id, metadata: { action: "op.action" } });

      return id;
    });

    const trace = await traceFor(traced);
    // THE ASSERTION THAT MATTERS. Five of six would look closed and would have
    // recreated the gap Item 1 existed to close.
    eq("all six sources contributed", [...trace.sources].sort(),
      ["execution", "job", "outbound", "security", "telemetry", "webhook"]);
    assert("the timeline is in order",
      trace.entries.every((e, i) => i === 0 || trace.entries[i - 1].at.getTime() <= e.at.getTime()),
      JSON.stringify(trace.entries.map((e) => e.source)));
    assert("it has a beginning and an end", !!trace.startedAt && !!trace.endedAt);

    // Each source keeps its own vocabulary rather than being flattened.
    const execution = trace.entries.find((e) => e.source === "execution");
    eq("an execution keeps its verified flag", execution?.detail.verified, false);
    eq("and its own status word", execution?.outcome, "FAILED");
    const outbound = trace.entries.find((e) => e.source === "outbound");
    eq("an outbound effect keeps the provider's reference", outbound?.detail.externalRef, "OP-1");
    const delivery = trace.entries.find((e) => e.source === "webhook");
    eq("a delivery keeps whether it was signed", delivery?.detail.signatureValid, true);
  }

  console.log("\n--- an unknown chain is empty, not an error ---\n");
  {
    const trace = await traceFor("not-a-correlation-id-at-all");
    eq("no entries", trace.entries.length, 0);
    eq("no sources", trace.sources, []);
    eq("and no invented times", [trace.startedAt, trace.endedAt], [null, null]);
  }

  console.log("\n--- recent traces surface failures, one row per chain ---\n");
  {
    const traced = await withCorrelation({ origin: "http" }, async () => {
      const id = correlationId()!;
      // Three failures in ONE chain. An operator has one thing to look at.
      for (let i = 0; i < 3; i++) {
        await recordExecution({
          executionId: `op-fail-${stamp}-${i}`, storeId: store.id, storeDraftId: null,
          action: `op.failed.${i}`, status: "FAILED", verified: false,
          message: "no", retryable: false, actorType: "GENESIS", actorId: null,
          schemaVersion: CURRENT_EXECUTION_SCHEMA_VERSION, timestamp: new Date(), metadata: undefined,
        });
      }
      return id;
    });

    const recent = await recentTraces(50);
    const mine = recent.filter((r) => r.correlationId === traced);
    eq("three failures collapse to one chain", mine.length, 1);
  }

  console.log("\n--- health assembles what already existed ---\n");
  {
    const health = await platformHealth();
    assert("the queue depth is reported", typeof health.queue.depth.pending === "number");
    assert("dead letters are listed", Array.isArray(health.queue.deadLetters));
    assert("indeterminate operations are listed", Array.isArray(health.indeterminate));
    assert("delivery health per provider", Array.isArray(health.webhooks.health));
    assert("the security tally", Array.isArray(health.security));
    assert("and the telemetry footprint", typeof health.telemetry.total === "number");
    assert("with a generation time", !!health.generatedAt);
  }

  console.log("\n--- needs-attention speaks only when somebody should act ---\n");
  {
    // A synthetic health object, so the four triggers are exercised
    // independently of whatever this shared database happens to contain.
    const quiet = {
      generatedAt: new Date().toISOString(),
      queue: { depth: { pending: 4, running: 1, done: 900, dead: 0 }, deadLetters: [], stalled: 0 },
      indeterminate: [],
      webhooks: { health: [{ provider: "x", received: 10, processed: 10, failed: 0, rejected: 0, lastReceivedAt: new Date() }], replayable: 0 },
      security: [{ kind: "authz.denied", severity: "warning", count: 3, lastSeenAt: new Date() }],
      telemetry: { total: 5000, oldest: new Date(), byName: [] },
    };
    // BUSY IS NOT BROKEN. Nine hundred completed jobs, pending work and routine
    // denials are a working platform, and flagging them is how a health check
    // becomes noise.
    eq("a busy, healthy platform raises nothing", needsAttention(quiet), []);

    eq("a dead letter speaks", needsAttention({
      ...quiet, queue: { ...quiet.queue, deadLetters: [{ id: "j1", kind: "noop", storeId: null, attempts: 5, lastError: "x", createdAt: new Date() }] },
    }).length, 1);
    eq("a stalled job speaks", needsAttention({ ...quiet, queue: { ...quiet.queue, stalled: 2 } }).length, 1);
    eq("an unknown external outcome speaks", needsAttention({
      ...quiet, indeterminate: [{ key: "k", operation: "o", storeId: null, attempts: 1, createdAt: new Date(), lastError: null }],
    }).length, 1);
    eq("a replayable delivery speaks", needsAttention({
      ...quiet, webhooks: { ...quiet.webhooks, replayable: 1 },
    }).length, 1);
    eq("and a critical signal speaks", needsAttention({
      ...quiet, security: [{ kind: "isolation.violation", severity: "critical", count: 1, lastSeenAt: new Date() }],
    }).length, 1);
  }

  console.log("\n--- the things that should be zero are found when they are not ---\n");
  {
    // An indeterminate operation, planted the way a crash produces one.
    await prismaSystem.outboundOperation.create({
      data: {
        idempotencyKey: `op-ind-${stamp}`, operation: "op.charge", storeId: store.id,
        status: "indeterminate", attempts: 1,
        claimedAt: new Date(Date.now() - CLAIM_TTL_MS - 1000),
      },
    });
    // A failed but verified delivery — replayable, and invisible until now.
    const rec = await recordDelivery({
      provider: `op-fail-${stamp}`, rawBody: "{}", signatureValid: true, storeId: store.id,
    });
    await markFailed(rec!.id, new Error("handler refused"));

    const health = await platformHealth();
    assert("the indeterminate operation is surfaced",
      health.indeterminate.some((o) => o.key === `op-ind-${stamp}`),
      JSON.stringify(health.indeterminate.map((o) => o.key)));
    assert("and the replayable delivery is counted", health.webhooks.replayable >= 1, `${health.webhooks.replayable}`);
    assert("so the platform asks for attention", needsAttention(health).length > 0, JSON.stringify(needsAttention(health)));
  }

  console.log(`\n${failures} failed, ${passes} passed\n`);
  await prismaSystem.$disconnect();
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
