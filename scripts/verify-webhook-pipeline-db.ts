import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { receiveWebhook } from "@/lib/webhooks/pipeline";
import { correlationId } from "@/lib/observability/correlation";
import { SIGNAL_KINDS, signalsForCorrelation } from "@/lib/security/signals";
import { enqueue, drain, type JobHandler } from "@/lib/jobs/queue";
import { runOnce } from "@/lib/outbound/runOnce";
import { getConnectorByName } from "@/lib/integrations/registry";
import { createHmac } from "crypto";

// THE GENERIC WEBHOOK PIPELINE:
//
//   part of the database sweep — npx tsx scripts/run-db-suites.ts webhook-pipeline-db
//
// ============ WHAT THIS HAS TO PROVE (2026-08-30) ======================
//
// The five failure modes a delivery system is judged on, and one property that
// is easy to lose without noticing:
//
//   a bad signature is REFUSED and recorded, not silently dropped
//   a duplicate event id is RECOGNISED rather than becoming a second record
//   a handler that throws leaves the delivery on file, replayable
//   the correlation id survives webhook → handler → queue, which is the
//     boundary a trace normally breaks at
//   nothing is verified after it is trusted — the ordering is structural
//
// EasyPost is exercised through its real connector contract rather than a
// stand-in, because the point of Item 5 is that a provider implements a
// contract and inherits the delivery system. A stand-in would prove the
// pipeline works and nothing about whether a connector can actually use it.

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
  const user = await prisma.user.create({ data: { email: `wp-${stamp}@example.test`, name: "Owner" } });
  const store = await prisma.store.create({
    data: { userId: user.id, name: "WP", slug: `wp-${stamp}`, tagline: "t", description: "d" },
  });
  const provider = `test-${stamp}`;

  console.log("\n--- a bad signature is refused, recorded, and signalled ---\n");
  {
    let handled = 0;
    const outcome = await receiveWebhook({
      provider,
      rawBody: '{"forged":true}',
      verify: () => ({ ok: false, error: "signature did not verify" }),
      handle: async () => { handled++; },
    });

    eq("it is rejected", outcome.status, "rejected");
    // THE ORDERING IS THE POINT: nothing is trusted before verification.
    eq("and the handler never ran", handled, 0);

    const row = await prismaSystem.webhookDelivery.findFirst({
      where: { provider, signatureValid: false }, orderBy: { receivedAt: "desc" },
    });
    assert("the forged delivery is on file", !!row);
    eq("marked rejected", row?.status, "rejected");
    eq("with the body kept verbatim", row?.payload, '{"forged":true}');

    const signals = await prismaSystem.securitySignal.count({
      where: { kind: SIGNAL_KINDS.webhookUnsigned, surface: `webhook:${provider}` },
    });
    assert("and a security signal was raised", signals >= 1, `${signals}`);
  }

  console.log("\n--- a duplicate event id is recognised, not dropped ---\n");
  {
    let handled = 0;
    const deliver = () =>
      receiveWebhook({
        provider,
        rawBody: '{"id":"evt_dup","amount":100}',
        verify: () => ({ ok: true, eventId: "evt_dup", storeId: store.id }),
        handle: async () => { handled++; },
      });

    const first = await deliver();
    const second = await deliver();

    eq("the first is processed", [first.status, first.status === "processed" && first.duplicate], ["processed", false]);
    eq("the second is recognised as a duplicate", second.status === "processed" && second.duplicate, true);
    eq("but there is still one delivery row",
      await prismaSystem.webhookDelivery.count({ where: { provider, externalEventId: "evt_dup" } }), 1);
    const row = await prismaSystem.webhookDelivery.findFirst({ where: { provider, externalEventId: "evt_dup" } });
    eq("with the arrival counted", row?.attempts, 2);
    // THE HANDLER STILL RUNS. A provider legitimately redelivers an event whose
    // first handling failed, and refusing to run it would break that recovery.
    // Not running twice is runOnce's job, not the delivery record's.
    eq("and the handler ran both times, by design", handled, 2);
  }

  console.log("\n--- a handler that throws leaves the delivery replayable ---\n");
  {
    const outcome = await receiveWebhook({
      provider,
      rawBody: '{"id":"evt_boom"}',
      verify: () => ({ ok: true, eventId: "evt_boom", storeId: store.id }),
      handle: async () => { throw new Error("handler exploded"); },
    });
    eq("the failure is reported to the caller", outcome.status, "failed");
    const row = await prismaSystem.webhookDelivery.findFirst({ where: { provider, externalEventId: "evt_boom" } });
    eq("the delivery is marked failed", row?.status, "failed");
    eq("with the reason", row?.error, "handler exploded");
    // What the provider sent survives, which is what makes a replay possible.
    eq("and the payload is intact", row?.payload, '{"id":"evt_boom"}');
  }

  console.log("\n--- the correlation id survives webhook → handler → queue ---\n");
  {
    let insideHandler: string | null = null;
    await receiveWebhook({
      provider,
      rawBody: '{"id":"evt_chain"}',
      verify: () => ({ ok: true, eventId: "evt_chain", storeId: store.id }),
      handle: async () => {
        insideHandler = correlationId();
        // The realistic shape: a webhook hands durable work to the queue.
        await enqueue({ kind: "noop", idempotencyKey: `wh-job-${stamp}`, storeId: store.id });
        await runOnce({
          key: `wh-out-${stamp}`, operation: "test.effect", storeId: store.id,
          perform: async () => ({ result: { ok: true }, externalRef: "E-1" }),
        });
      },
    });

    assert("the handler ran inside a chain", !!insideHandler);
    const id = insideHandler!;
    eq("the delivery joins it",
      await prismaSystem.webhookDelivery.count({ where: { correlationId: id } }), 1);
    eq("the job it enqueued joins it",
      await prismaSystem.job.count({ where: { correlationId: id } }), 1);
    eq("the outbound effect joins it",
      await prismaSystem.outboundOperation.count({ where: { correlationId: id } }), 1);

    // THE BOUNDARY THAT NORMALLY BREAKS. The job runs later, in a process that
    // never saw the request.
    let insideJob: string | null = null;
    const handler: JobHandler = async () => { insideJob = correlationId(); };
    await drain({ noop: handler }, { maxJobs: 10 });
    eq("and the job's own run rejoins the webhook's chain", insideJob, id);
  }

  console.log("\n--- the EasyPost connector implements the contract for real ---\n");
  {
    const connector = getConnectorByName("EASYPOST");
    assert("the connector declares webhooks", !!connector.webhooks, "no webhooks on the connector");

    const prior = process.env.EASYPOST_WEBHOOK_SECRET;
    process.env.EASYPOST_WEBHOOK_SECRET = "shh";
    const body = JSON.stringify({ id: "evt_ep_1", description: "tracker.updated", result: {} });
    // THE HEADER CARRIES AN ALGORITHM PREFIX. My first version signed the body
    // correctly and omitted the prefix, so a valid signature was refused — the
    // failing test was right and the test was wrong. Read from
    // isValidEasyPostSignature rather than guessed at.
    const sign = (b: string) =>
      `hmac-sha256-hex=${createHmac("sha256", "shh").update(b, "utf8").digest("hex")}`;

    const good = await connector.webhooks!.verify(body, new Headers({ "x-hmac-signature": sign(body) }));
    assert("a correctly signed body verifies", good.ok, JSON.stringify(good));
    eq("and its event id is read from the payload", good.eventId, "evt_ep_1");

    const bad = await connector.webhooks!.verify(body, new Headers({ "x-hmac-signature": "deadbeef" }));
    assert("a wrong signature does not", !bad.ok, JSON.stringify(bad));

    // NEVER THROWS on a hostile payload — a verifier that does lets a prober
    // distinguish malformed from wrongly-signed from the outside.
    let threw = false;
    try {
      await connector.webhooks!.verify("not json at all", new Headers({ "x-hmac-signature": sign("not json at all") }));
      await connector.webhooks!.verify("", new Headers());
    } catch { threw = true; }
    assert("and a hostile payload never makes it throw", !threw);

    delete process.env.EASYPOST_WEBHOOK_SECRET;
    const unconfigured = await connector.webhooks!.verify(body, new Headers({ "x-hmac-signature": sign(body) }));
    // No secret means no request can be authenticated, and accepting
    // unauthenticated delivery updates is strictly worse than accepting none.
    assert("with no secret configured nothing verifies", !unconfigured.ok, JSON.stringify(unconfigured));
    process.env.EASYPOST_WEBHOOK_SECRET = prior;
  }

  console.log("\n--- a verifier that throws is a rejection, not a 500 ---\n");
  {
    let handled = 0;
    const outcome = await receiveWebhook({
      provider,
      rawBody: "{}",
      verify: () => { throw new Error("verifier blew up"); },
      handle: async () => { handled++; },
    });
    eq("it is rejected rather than propagating", outcome.status, "rejected");
    eq("and nothing was handled", handled, 0);
  }

  console.log("\n--- the production notification handler is wired ---\n");
  {
    // Gap 10 from Item 4: production registers a default handler that no test
    // exercised, because every suite built its own with an injected sender.
    const { HANDLERS, JOB_KINDS } = await import("@/lib/jobs/registry");
    assert("notification.order is a declared kind",
      (JOB_KINDS as readonly string[]).includes("notification.order"));
    assert("and the registry has a handler for it", typeof HANDLERS["notification.order"] === "function");
    eq("every declared kind has one",
      (JOB_KINDS as readonly string[]).filter((k) => typeof HANDLERS[k] !== "function"), []);
  }

  console.log(`\n${failures} failed, ${passes} passed\n`);
  await prismaSystem.$disconnect();
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
