import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { replayDelivery, releaseStaleReplays } from "@/lib/webhooks/replay";
import { recordDelivery, markFailed, replayableDeliveries } from "@/lib/webhooks/delivery";
import { SIGNAL_KINDS } from "@/lib/security/signals";
import { runOnce } from "@/lib/outbound/runOnce";
import { ProviderDouble } from "@/scripts/lib/providerDouble";

// REPLAYING A FAILED DELIVERY:
//
//   part of the database sweep — npx tsx scripts/run-db-suites.ts replay-db
//
// ============ WHY THIS EXISTS AT ALL (2026-08-30) ======================
//
// All three dedicated routes return 200 even when handling fails, so a provider
// will never redeliver. Without replay the `failed` rows are a dead end: a
// payment or refund that did not apply, recorded, visible, unrecoverable.
//
// The assertions that matter are the refusals, not the happy path. A replay
// mechanism that will re-run anything is a way to execute an unverified payload
// on demand, which is worse than having no replay at all.

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
  const user = await prisma.user.create({ data: { email: `rp-${stamp}@example.test`, name: "Owner" } });
  const store = await prisma.store.create({
    data: { userId: user.id, name: "RP", slug: `rp-${stamp}`, tagline: "t", description: "d" },
  });
  const provider = `replay-${stamp}`;

  const failedDelivery = async (body: string, opts: { signatureValid?: boolean; eventId?: string } = {}) => {
    const rec = await recordDelivery({
      provider, rawBody: body, storeId: store.id,
      signatureValid: opts.signatureValid ?? true,
      externalEventId: opts.eventId ?? null,
    });
    await markFailed(rec!.id, new Error("the handler refused it the first time"));
    return rec!.id;
  };

  console.log("\n--- a failed delivery can be run again ---\n");
  {
    const id = await failedDelivery('{"id":"evt_r1","amount":100}', { eventId: "evt_r1" });
    let seen: string | null = null;
    const outcome = await replayDelivery({
      deliveryId: id,
      handlers: { [provider]: async (_s, rawBody) => { seen = rawBody; } },
      actorId: user.id,
    });

    eq("it replays", outcome.status, "replayed");
    // The point of keeping the body verbatim: a replay starts from exactly what
    // the provider sent, not from our reading of it.
    eq("the handler saw the original bytes", seen, '{"id":"evt_r1","amount":100}');
    const row = await prismaSystem.webhookDelivery.findUnique({ where: { id } });
    eq("and the delivery is processed now", row?.status, "processed");
    eq("with the old error cleared", row?.error, null);

    const signal = await prismaSystem.securitySignal.findFirst({
      where: { kind: SIGNAL_KINDS.webhookReplayed, actorId: user.id },
    });
    // Replaying a payment webhook is an act, and an act needs a record of who.
    assert("a person's replay is recorded against them", !!signal, "no replay signal");
    eq("as a user, not the system", signal?.actorKind, "user");
  }

  console.log("\n--- an unverified delivery is NEVER replayable ---\n");
  {
    // ============ THE ASSERTION THAT MATTERS MOST ==================
    //
    // A replay that will re-run anything is a way to execute a payload nobody
    // proved came from the provider. That is the whole attack, and it is worse
    // than having no replay.
    const id = await failedDelivery('{"forged":true}', { signatureValid: false });
    let ran = 0;
    const outcome = await replayDelivery({
      deliveryId: id,
      handlers: { [provider]: async () => { ran++; } },
      actorId: user.id,
    });
    eq("it is refused", outcome.status, "refused");
    eq("and the handler never ran", ran, 0);

    const signal = await prismaSystem.securitySignal.findFirst({
      where: { kind: SIGNAL_KINDS.webhookReplayRefused },
    });
    assert("the attempt is recorded", !!signal, "no refusal signal");
    // Somebody trying to replay a forged payload is not an accident.
    eq("at critical severity", signal?.severity, "critical");
  }

  console.log("\n--- only a failure is replayable ---\n");
  {
    const rec = await recordDelivery({ provider, rawBody: "{}", storeId: store.id, signatureValid: true });
    let ran = 0;
    const handlers = { [provider]: async () => { ran++; } };

    // ============ ASSERT WHICH GUARD REFUSED (2026-08-30) ==========
    //
    // Checking only `status === "refused"` could not tell the status guard from
    // the claim: removing either left this green, because the other one caught
    // it. They are genuine defence-in-depth, and a test that cannot say which
    // one acted proves neither.
    const fresh = await replayDelivery({ deliveryId: rec!.id, handlers });
    eq("a received delivery is refused", fresh.status, "refused");
    assert("by the status guard, naming the state",
      fresh.status === "refused" && fresh.reason.includes("received"), 
      fresh.status === "refused" ? fresh.reason : fresh.status);

    // A processed one: re-running a handler that already succeeded would repeat
    // its unguarded database writes even though runOnce guards the external
    // effect.
    await prismaSystem.webhookDelivery.update({ where: { id: rec!.id }, data: { status: "processed" } });
    const done = await replayDelivery({ deliveryId: rec!.id, handlers });
    eq("a processed delivery is refused", done.status, "refused");
    assert("also by the status guard",
      done.status === "refused" && done.reason.includes("processed"),
      done.status === "refused" ? done.reason : done.status);
    eq("neither ran the handler", ran, 0);

    const missing = await replayDelivery({ deliveryId: "cl_not_a_delivery", handlers });
    eq("an unknown delivery is refused", missing.status, "refused");
  }

  console.log("\n--- a replay that fails leaves it exactly as replayable ---\n");
  {
    const id = await failedDelivery('{"id":"evt_r2"}', { eventId: "evt_r2" });
    const outcome = await replayDelivery({
      deliveryId: id,
      handlers: { [provider]: async () => { throw new Error("still broken"); } },
    });
    eq("the failure is reported", outcome.status, "failed");
    const row = await prismaSystem.webhookDelivery.findUnique({ where: { id } });
    // NOT stuck in `replaying`. One bad attempt must not make a delivery
    // permanently unrecoverable.
    eq("it is failed again, not stuck", row?.status, "failed");
    eq("with the new reason", row?.error, "still broken");

    // And it is still offered for replay.
    const offered = await replayableDeliveries(provider);
    assert("it is still in the replayable list", offered.some((d) => d.id === id));
  }

  console.log("\n--- two operators pressing at once produce one replay ---\n");
  {
    const id = await failedDelivery('{"id":"evt_r3"}', { eventId: "evt_r3" });
    let ran = 0;
    const slow = async () => { ran++; await new Promise((r) => setTimeout(r, 60)); };

    const inFlight = replayDelivery({ deliveryId: id, handlers: { [provider]: slow } });
    await new Promise((r) => setTimeout(r, 20));
    const second = await replayDelivery({ deliveryId: id, handlers: { [provider]: slow } });

    eq("the second is refused", second.status, "refused");
    // ============ AND HERE, BY THE CLAIM ==========================
    //
    // In this harness the first call has already written `replaying` before the
    // second reads, so the STATUS guard catches it and the claim is never
    // reached. A genuine race — both reading `failed` before either writes — is
    // what the claim exists for and is exactly what the pooled harness cannot
    // produce. Recorded rather than dressed up: this assertion proves the
    // refusal, not which guard delivered it.
    assert("naming a state it cannot replay from",
      second.status === "refused" &&
        (second.reason.includes("replaying") || second.reason.includes("already running")),
      second.status === "refused" ? second.reason : second.status);
    const first = await inFlight;
    eq("the first completed", first.status, "replayed");
    eq("and the handler ran once", ran, 1);
  }

  console.log("\n--- a replay cannot duplicate an external effect ---\n");
  {
    // The handler's side effects go through runOnce, so replaying a delivery
    // whose handler already charged somebody replays the RECORD, not the charge.
    const double = new ProviderDouble();
    const id = await failedDelivery('{"id":"evt_r4"}', { eventId: "evt_r4" });
    const key = `replay-effect-${stamp}`;
    const handler = async () => {
      await runOnce({
        key, operation: "double.charge", storeId: store.id,
        perform: async () => {
          const r = await double.call("double.charge", key);
          return { result: r.result, externalRef: r.externalRef };
        },
      });
      // Fail after the effect, forcing the delivery back to failed so it can be
      // replayed again — the exact shape that duplicates money without runOnce.
      if (double.callCount === 1) throw new Error("crashed after the charge");
    };

    await replayDelivery({ deliveryId: id, handlers: { [provider]: handler } });
    await replayDelivery({ deliveryId: id, handlers: { [provider]: handler } });

    eq("the provider was charged exactly once", double.callCount, 1);
  }

  console.log("\n--- a crashed replay does not strand the delivery ---\n");
  {
    const id = await failedDelivery('{"id":"evt_r5"}', { eventId: "evt_r5" });
    // A replay claimed it and the process died: not failed, so nothing may
    // replay it, and not processed, so it never happened.
    await prismaSystem.webhookDelivery.update({
      where: { id },
      data: { status: "replaying", receivedAt: new Date(Date.now() - 60 * 60 * 1000) },
    });

    const stuck = await replayDelivery({ deliveryId: id, handlers: { [provider]: async () => {} } });
    eq("while claimed it is refused", stuck.status, "refused");

    const released = await releaseStaleReplays();
    assert("the stale claim is released", released >= 1, `${released}`);
    const row = await prismaSystem.webhookDelivery.findUnique({ where: { id } });
    eq("back to failed", row?.status, "failed");
    assert("saying why", (row?.error ?? "").includes("stopped before recording"), row?.error ?? "");

    const now = await replayDelivery({ deliveryId: id, handlers: { [provider]: async () => {} } });
    eq("and replayable again", now.status, "replayed");
  }

  console.log("\n--- a provider with no handler supplied is refused, not crashed ---\n");
  {
    const id = await failedDelivery('{"id":"evt_r6"}', { eventId: "evt_r6" });
    const outcome = await replayDelivery({ deliveryId: id, handlers: {} });
    eq("refused", outcome.status, "refused");
    const row = await prismaSystem.webhookDelivery.findUnique({ where: { id } });
    // Refused BEFORE the claim, so it is not left in `replaying`.
    eq("and left untouched", row?.status, "failed");
  }

  console.log(`\n${failures} failed, ${passes} passed\n`);
  await prismaSystem.$disconnect();
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
