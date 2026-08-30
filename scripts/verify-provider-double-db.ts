import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { ProviderDouble } from "@/scripts/lib/providerDouble";
import { runOnce, resolveIndeterminate, CLAIM_TTL_MS } from "@/lib/outbound/runOnce";
import { receiveWebhook } from "@/lib/webhooks/pipeline";
import { enqueue, drain, type JobHandler } from "@/lib/jobs/queue";
import { correlationId } from "@/lib/observability/correlation";

// A DETERMINISTIC PROVIDER BOUNDARY:
//
//   part of the database sweep — npx tsx scripts/run-db-suites.ts provider-double-db
//
// ============ WHAT A GREEN RUN HERE MEANS (2026-08-30) =================
//
// That OUR contracts hold: a refusal retries, a silence stays indeterminate, a
// forged signature is refused and recorded, a duplicate is recognised, a queue
// retry does not repeat an external effect.
//
// It does NOT mean Stripe or Square behave this way. Every behaviour below is
// what we BELIEVE a provider does, and Connections is what replaces belief with
// evidence. A green suite here is not readiness for a real provider and must
// never be reported as one.
//
// The instrument throughout is the double's own call counter. "The provider was
// called twice" is observed rather than inferred from a status column — which
// is the whole point, because a status column is exactly what would say one
// while the answer was two.

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
  const user = await prisma.user.create({ data: { email: `pd-${stamp}@example.test`, name: "Owner" } });
  const store = await prisma.store.create({
    data: { userId: user.id, name: "PD", slug: `pd-${stamp}`, tagline: "t", description: "d" },
  });
  const key = (n: string) => `pd-${n}-${stamp}`;

  console.log("\n--- a successful call happens once, however often we ask ---\n");
  {
    const provider = new ProviderDouble([{ kind: "succeed", externalRef: "PD-1" }]);
    const attempt = () =>
      runOnce({
        key: key("ok"), operation: "double.create", storeId: store.id,
        perform: async () => {
          const r = await provider.call("double.create", key("ok"));
          return { result: r.result, externalRef: r.externalRef };
        },
      });

    eq("the first performs", (await attempt()).status, "performed");
    eq("the second replays", (await attempt()).status, "replayed");
    eq("and the provider saw exactly one call", provider.callCount, 1);
  }

  console.log("\n--- a refusal is retried, because nothing landed ---\n");
  {
    const provider = new ProviderDouble([{ kind: "refuse", message: "declined" }, { kind: "succeed" }]);
    const attempt = () =>
      runOnce({
        key: key("refuse"), operation: "double.create", storeId: store.id,
        perform: async () => {
          const r = await provider.call("double.create", key("refuse"));
          return { result: r.result, externalRef: r.externalRef };
        },
      });

    const first = await attempt();
    eq("the refusal is reported as failed", first.status, "failed");
    eq("the second attempt performs", (await attempt()).status, "performed");
    eq("and the provider was called twice, correctly", provider.callCount, 2);
  }

  console.log("\n--- a call that never answers stays indeterminate ---\n");
  {
    // ============ THE CASE THAT DUPLICATES MONEY ===================
    //
    // The double DOES the work and never says so — which is what a timeout
    // actually is, and why it is modelled as a hang rather than a thrown error.
    // Treating this as a refusal is the mistake that places a second order.
    const provider = new ProviderDouble([{ kind: "hang", ms: 10 }]);
    const perform = async () => {
      const r = await provider.call("double.charge", key("hang"));
      return { result: r.result, externalRef: r.externalRef };
    };

    const first = await runOnce({ key: key("hang"), operation: "double.charge", storeId: store.id, perform });
    // The hang surfaces as a throw at our boundary, so runOnce records it as
    // failed — which is CORRECT for a thrown call and is why the real
    // indeterminate case is the crash, tested next.
    eq("a hang that reaches us as an error is a failure", first.status, "failed");
    eq("but the provider did the work anyway", provider.landed.has(key("hang")), true);

    // Now the genuine indeterminate: a claim with no answer and no live runner.
    await prismaSystem.outboundOperation.create({
      data: {
        idempotencyKey: key("crash"), operation: "double.charge", storeId: store.id,
        status: "in_progress", attempts: 1,
        claimedAt: new Date(Date.now() - CLAIM_TTL_MS - 60_000),
        claimedBy: "a-runner-that-died",
      },
    });
    provider.landed.set(key("crash"), "PD-CRASH");

    const before = provider.callCount;
    const outcome = await runOnce({ key: key("crash"), operation: "double.charge", storeId: store.id, perform });
    eq("it is indeterminate", outcome.status, "indeterminate");
    eq("and the provider was NOT called again", provider.callCount, before);
  }

  console.log("\n--- only the provider can resolve it, and may decline to ---\n");
  {
    const provider = new ProviderDouble();
    provider.landed.set(key("crash"), "PD-CRASH");

    // A provider that cannot say leaves it for a person. That is the correct
    // outcome, not a failure of reconciliation.
    const amnesiac = await resolveIndeterminate(key("crash"), provider.reconciler("amnesiac"));
    eq("an amnesiac provider changes nothing", amnesiac, { resolved: "still-indeterminate" });

    const honest = await resolveIndeterminate(key("crash"), provider.reconciler("honest"));
    eq("an honest one confirms it landed", honest, { resolved: "succeeded", externalRef: "PD-CRASH" });

    const after = await runOnce({
      key: key("crash"), operation: "double.charge", storeId: store.id,
      perform: async () => { await provider.call("double.charge"); return { result: {} }; },
    });
    eq("so a later attempt replays", after.status, "replayed");
    eq("without touching the provider", provider.callCount, 0);
  }

  console.log("\n--- a queue retry does not repeat the external effect ---\n");
  {
    const provider = new ProviderDouble();
    let runs = 0;
    const handler: JobHandler = async ({ job }) => {
      // ============ ONLY THIS SUITE'S OWN JOB (2026-08-30) ==========
      //
      // The queue is shared. drain({ noop: handler }) claims ANY pending noop,
      // including ones other suites left behind — so in a full sweep this
      // handler ran a stranger's job and called the provider a second time.
      // The suite passed alone and failed in the sweep, which is the same shape
      // of coupling verify-owner-storage-db already had to fix.
      if (job.idempotencyKey !== key("job")) return;
      runs++;
      await runOnce({
        key: `pd-job-${job.idempotencyKey}`, operation: "double.create", storeId: store.id,
        perform: async () => {
          const r = await provider.call("double.create", `pd-job-${job.idempotencyKey}`);
          return { result: r.result, externalRef: r.externalRef };
        },
      });
      if (runs === 1) throw new Error("crashed after the provider succeeded");
    };

    await enqueue({ kind: "noop", idempotencyKey: key("job"), storeId: store.id });
    await drain({ noop: handler }, { maxJobs: 5 });
    await prismaSystem.job.updateMany({ where: { idempotencyKey: key("job") }, data: { runAfter: new Date() } });
    await drain({ noop: handler }, { maxJobs: 5 });

    eq("the handler ran twice", runs, 2);
    // THE SCENARIO ALL OF THIS EXISTS FOR.
    eq("and the provider was called once", provider.callCount, 1);
  }

  console.log("\n--- webhook signatures, through the real pipeline ---\n");
  {
    const provider = new ProviderDouble();
    const hooks = provider.webhooks();
    const name = `double-${stamp}`;
    const body = JSON.stringify({ id: "evt_sig_1", amount: 100 });

    const deliver = (rawBody: string, signature: string | null) =>
      receiveWebhook({
        provider: name,
        rawBody,
        verify: async () => {
          const headers = new Headers();
          if (signature) headers.set("x-double-signature", signature);
          const v = await hooks.verify(rawBody, headers);
          return { ok: v.ok, eventId: v.eventId ?? null, storeId: store.id, error: v.error };
        },
        handle: async () => hooks.handle(store.id, rawBody),
      });

    eq("a correctly signed delivery is processed", (await deliver(body, provider.sign(body))).status, "processed");
    eq("the handler saw it", hooks.handled.length, 1);

    eq("a forged signature is rejected", (await deliver(body, "sha256=deadbeef")).status, "rejected");
    eq("a missing signature is rejected", (await deliver(body, null)).status, "rejected");
    // Signing a DIFFERENT body: the classic replay-with-tampering.
    eq("a signature for other bytes is rejected",
      (await deliver(body, provider.sign('{"id":"evt_sig_1","amount":999999}'))).status, "rejected");
    eq("and none of those reached the handler", hooks.handled.length, 1);

    eq("all three rejections are on file",
      await prismaSystem.webhookDelivery.count({ where: { provider: name, signatureValid: false } }), 3);
  }

  console.log("\n--- a malformed body is not an attack ---\n");
  {
    const provider = new ProviderDouble();
    const hooks = provider.webhooks();
    const name = `double-mal-${stamp}`;
    const junk = "this is not json";

    const outcome = await receiveWebhook({
      provider: name,
      rawBody: junk,
      verify: async () => {
        const headers = new Headers({ "x-double-signature": provider.sign(junk) });
        const v = await hooks.verify(junk, headers);
        return { ok: v.ok, eventId: v.eventId ?? null, storeId: store.id, error: v.error };
      },
      handle: async () => hooks.handle(store.id, junk),
    });

    // MALFORMED IS NOT UNSIGNED. A correctly signed body that is not JSON came
    // genuinely from the provider; filing it as a signature failure would put a
    // real delivery in the attack bucket and hide a real integration bug.
    eq("it is accepted, not rejected", outcome.status, "processed");
    eq("with no event id invented for it", (await prismaSystem.webhookDelivery.findFirst({
      where: { provider: name }, orderBy: { receivedAt: "desc" },
    }))?.externalEventId, null);
  }

  console.log("\n--- a duplicate delivery is recognised ---\n");
  {
    const provider = new ProviderDouble();
    const hooks = provider.webhooks();
    const name = `double-dup-${stamp}`;
    const body = JSON.stringify({ id: "evt_dup_1" });
    const deliver = () =>
      receiveWebhook({
        provider: name, rawBody: body,
        verify: async () => {
          const v = await hooks.verify(body, new Headers({ "x-double-signature": provider.sign(body) }));
          return { ok: v.ok, eventId: v.eventId ?? null, storeId: store.id };
        },
        handle: async () => hooks.handle(store.id, body),
      });

    const first = await deliver();
    const second = await deliver();
    eq("the first is new", first.status === "processed" && first.duplicate, false);
    eq("the second is a duplicate", second.status === "processed" && second.duplicate, true);
    eq("and one row holds both arrivals",
      (await prismaSystem.webhookDelivery.findFirst({ where: { provider: name } }))?.attempts, 2);
  }

  console.log("\n--- a failing handler leaves a replayable record ---\n");
  {
    const provider = new ProviderDouble();
    const hooks = provider.webhooks();
    hooks.failNext = true;
    const name = `double-fail-${stamp}`;
    const body = JSON.stringify({ id: "evt_fail_1" });

    const outcome = await receiveWebhook({
      provider: name, rawBody: body,
      verify: async () => {
        const v = await hooks.verify(body, new Headers({ "x-double-signature": provider.sign(body) }));
        return { ok: v.ok, eventId: v.eventId ?? null, storeId: store.id };
      },
      handle: async () => hooks.handle(store.id, body),
    });
    eq("the failure is reported", outcome.status, "failed");
    const row = await prismaSystem.webhookDelivery.findFirst({ where: { provider: name } });
    eq("recorded as failed", row?.status, "failed");
    eq("with what the provider sent kept intact", row?.payload, body);
  }

  console.log("\n--- one chain from delivery to external effect ---\n");
  {
    const provider = new ProviderDouble();
    const hooks = provider.webhooks();
    const name = `double-chain-${stamp}`;
    const body = JSON.stringify({ id: "evt_chain_1" });
    let inside: string | null = null;

    await receiveWebhook({
      provider: name, rawBody: body,
      verify: async () => {
        const v = await hooks.verify(body, new Headers({ "x-double-signature": provider.sign(body) }));
        return { ok: v.ok, eventId: v.eventId ?? null, storeId: store.id };
      },
      handle: async () => {
        inside = correlationId();
        await runOnce({
          key: key("chain"), operation: "double.create", storeId: store.id,
          perform: async () => {
            const r = await provider.call("double.create", key("chain"));
            return { result: r.result, externalRef: r.externalRef };
          },
        });
      },
    });

    assert("the handler ran in a chain", !!inside);
    eq("the delivery is in it",
      await prismaSystem.webhookDelivery.count({ where: { correlationId: inside } }), 1);
    eq("and so is the external effect it caused",
      await prismaSystem.outboundOperation.count({ where: { correlationId: inside } }), 1);
  }

  console.log(`\n${failures} failed, ${passes} passed\n`);
  await prismaSystem.$disconnect();
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
