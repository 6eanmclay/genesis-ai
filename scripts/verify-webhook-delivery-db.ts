import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import {
  recordDelivery,
  markProcessed,
  markFailed,
  deliveryHealth,
  replayableDeliveries,
} from "@/lib/webhooks/delivery";

// THE WEBHOOK AUDIT TRAIL, AGAINST A REAL DATABASE:
//
//   part of the database sweep — npx tsx scripts/run-db-suites.ts webhook-delivery-db
//
// ============ THE PROPERTY THAT MATTERS MOST ===========================
//
// Recording must never break a delivery. A webhook route's job is to take what
// the provider sent and return; if the audit write fails, the right outcome is
// a missing audit row and a working payment — never a 500 that makes the
// provider retry a payment already processed.
//
// So the first thing asserted here is that every function survives a database
// that refuses it, and none of them throws.

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
  const user = await prisma.user.create({ data: { email: `wh-${stamp}@example.test`, name: "Owner" } });
  const store = await prisma.store.create({
    data: { userId: user.id, name: "WH", slug: `wh-${stamp}`, tagline: "t", description: "d" },
  });
  const provider = `test-provider-${stamp}`;

  console.log("\n--- a verified delivery is recorded verbatim ---\n");
  {
    const body = '{"id":"evt_1","amount":4200,"nested":{"weird":"\\"quoted\\""}}';
    const recorded = await recordDelivery({
      provider, rawBody: body, signatureValid: true,
      externalEventId: "evt_1", storeId: store.id,
      headers: { "x-signature": "abc" },
    });
    assert("it is recorded", !!recorded);
    eq("and is not a duplicate", recorded?.duplicate, false);

    const row = await prismaSystem.webhookDelivery.findUnique({ where: { id: recorded!.id } });
    // VERBATIM. A parsed copy would be our reading of the delivery rather than
    // the delivery, and a replay has to start from what was actually sent.
    eq("the body is byte-for-byte what arrived", row?.payload, body);
    eq("with the provider's own event id", row?.externalEventId, "evt_1");
    eq("attributed to the business", row?.storeId, store.id);
    eq("and marked received", [row?.status, row?.signatureValid], ["received", true]);
    eq("headers are kept", (row?.headers as Record<string, string>)?.["x-signature"], "abc");
  }

  console.log("\n--- a retry of the same event is recognised, not duplicated ---\n");
  {
    const again = await recordDelivery({
      provider, rawBody: '{"id":"evt_1"}', signatureValid: true,
      externalEventId: "evt_1", storeId: store.id,
    });
    eq("it reports a duplicate", again?.duplicate, true);
    eq("there is still one row", await prismaSystem.webhookDelivery.count({ where: { provider, externalEventId: "evt_1" } }), 1);
    const row = await prismaSystem.webhookDelivery.findFirst({ where: { provider, externalEventId: "evt_1" } });
    // "This arrived four times" has to be answerable, or a provider stuck in a
    // retry loop is invisible.
    eq("but the arrival was counted", row?.attempts, 2);
  }

  console.log("\n--- a provider with no event id is not constrained ---\n");
  {
    // Postgres treats NULLs as distinct in a unique index, which is what lets a
    // provider that names nothing deliver as often as it likes.
    const a = await recordDelivery({ provider, rawBody: "{}", signatureValid: true, storeId: store.id });
    const b = await recordDelivery({ provider, rawBody: "{}", signatureValid: true, storeId: store.id });
    assert("both are recorded", !!a && !!b && a.id !== b.id);
    eq("as two separate deliveries", [a?.duplicate, b?.duplicate], [false, false]);
  }

  console.log("\n--- a failed signature is written down, not dropped ---\n");
  {
    const rejected = await recordDelivery({
      provider, rawBody: '{"forged":true}', signatureValid: false, externalEventId: "evt_forged",
    });
    const row = await prismaSystem.webhookDelivery.findUnique({ where: { id: rejected!.id } });
    eq("it is marked rejected", row?.status, "rejected");
    eq("with the signature recorded as invalid", row?.signatureValid, false);
    eq("and no business attributed to it", row?.storeId, null);
    // One is noise. A burst is a rotated secret nobody updated, or somebody
    // probing — and neither is visible if the only trace is a 400 in a log.
    assert("the forged body is still on file", row?.payload === '{"forged":true}');
  }

  console.log("\n--- processed and failed are both terminal, and both keep the payload ---\n");
  {
    const ok = await recordDelivery({ provider, rawBody: "{}", signatureValid: true, externalEventId: "evt_ok", storeId: store.id });
    await markProcessed(ok!.id, store.id);
    const okRow = await prismaSystem.webhookDelivery.findUnique({ where: { id: ok!.id } });
    eq("processed is recorded with a time", [okRow?.status, okRow?.processedAt !== null], ["processed", true]);

    const bad = await recordDelivery({ provider, rawBody: '{"x":1}', signatureValid: true, externalEventId: "evt_bad", storeId: store.id });
    await markFailed(bad!.id, new Error("handler exploded"));
    const badRow = await prismaSystem.webhookDelivery.findUnique({ where: { id: bad!.id } });
    eq("failure keeps the reason", [badRow?.status, badRow?.error], ["failed", "handler exploded"]);
    eq("and the payload survives, so it can be replayed", badRow?.payload, '{"x":1}');
  }

  console.log("\n--- recording never throws, whatever happens ---\n");
  {
    // THE PROPERTY THAT MATTERS MOST. An id that does not exist makes the
    // update throw inside; the caller must not see it.
    let threw = false;
    try {
      await markProcessed("cl_does_not_exist_at_all");
      await markFailed("cl_does_not_exist_at_all", new Error("x"));
      await markProcessed(null);
      await markFailed(null, new Error("x"));
    } catch {
      threw = true;
    }
    assert("marking a delivery that is not there is survivable", !threw);

    // A store id that does not exist violates the foreign key, so the insert
    // genuinely fails inside. The caller must get null, not an exception.
    //
    // The first version of this assertion was `huge === null || !!huge` — a
    // tautology that could not fail. It is the exact shape of check this
    // codebase has been bitten by before, so it is now written as what it
    // means: recording threw, or it did not.
    let recordThrew = false;
    let outcome: unknown = "never ran";
    try {
      outcome = await recordDelivery({
        provider,
        rawBody: '{"orphan":true}',
        signatureValid: true,
        storeId: "cl_store_that_does_not_exist",
      });
    } catch {
      recordThrew = true;
    }
    assert("a delivery that cannot be stored does not propagate", !recordThrew);
    eq("and reports the failure by returning null", outcome, null);
  }

  console.log("\n--- an operator can see what each provider is sending ---\n");
  {
    const health = await deliveryHealth();
    const mine = health.find((h) => h.provider === provider);
    assert("the provider appears", !!mine, JSON.stringify(health.map((h) => h.provider)));
    assert("with its rejected count visible", (mine?.rejected ?? 0) >= 1, JSON.stringify(mine));
    assert("and its processed count", (mine?.processed ?? 0) >= 1, JSON.stringify(mine));
    assert("and when it last sent anything", mine?.lastReceivedAt !== null);

    const replayable = await replayableDeliveries(provider);
    eq("exactly the failed ones are offered for replay", replayable.length, 1);
    eq("carrying what was sent", replayable[0]?.payload, '{"x":1}');
    // READ ONLY. Replaying a payment webhook must not be something a report can
    // do by being read.
    assert("and the report itself changed nothing",
      (await prismaSystem.webhookDelivery.findUnique({ where: { id: replayable[0].id } }))?.status === "failed");
  }

  console.log("\n--- history outlives the business it was about ---\n");
  {
    const doomed = await prisma.store.create({
      data: { userId: user.id, name: "Doomed", slug: `wh-d-${stamp}`, tagline: "t", description: "d" },
    });
    const kept = await recordDelivery({
      provider, rawBody: '{"paid":true}', signatureValid: true,
      externalEventId: "evt_money", storeId: doomed.id,
    });
    await prismaSystem.store.delete({ where: { id: doomed.id } });

    const row = await prismaSystem.webhookDelivery.findUnique({ where: { id: kept!.id } });
    // SetNull, not Cascade: a deleted store must not erase the record that
    // money moved.
    assert("the delivery survives the store", row !== null);
    eq("with the attribution cleared rather than the row", row?.storeId, null);
    eq("and the payload intact", row?.payload, '{"paid":true}');
  }

  console.log(`\n${failures} failed, ${passes} passed\n`);
  await prismaSystem.$disconnect();
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
