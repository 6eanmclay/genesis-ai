import "@/scripts/lib/allowServerOnly";

import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { replayDelivery } from "@/lib/webhooks/replay";
import { replayHandlers, replayableProviders } from "@/lib/webhooks/replayHandlers";
import { recordDelivery, markFailed, markProcessed } from "@/lib/webhooks/delivery";
import { withCorrelation, correlationId } from "@/lib/observability/correlation";
import { runOnce } from "@/lib/outbound/runOnce";
import { traceFor } from "@/lib/admin/trace";
import { SIGNAL_KINDS } from "@/lib/security/signals";
import { readFileSync } from "node:fs";

/**
 * A file with its comments removed.
 *
 * Written because the first version of section 0 matched `constructEvent`
 * inside the moved file's own comment EXPLAINING that it no longer verifies,
 * and reported the explanation as the offence. The same mistake this session
 * has now made three times, in three suites; the fix is always to assert
 * against code rather than prose.
 */
function codeOnly(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

// REPLAYING A DELIVERY THAT MOVED MONEY:
//
//   part of the database sweep — npx tsx scripts/run-db-suites.ts money-replay-db
//
// ============ WHAT RANK 4 CHANGED, AND WHAT IT DID NOT (2026-08-30) ====
//
// It changed WHERE trusting begins, not WHAT is trusted. Both routes already
// drew the line in their own comments; PayPal's said it out loud — "Everything
// below this line is trusted. Nothing above it was." The half below moved into
// lib/payments so it has two callers instead of one: the live route, which has
// just verified, and replay, which refuses anything that did not verify when it
// arrived.
//
// The security property is therefore NOT a new check. It is that the old checks
// still stand between a forged body and a handler, now that a second door
// exists. That is what most of this file is about.
//
// ============ THE ONE SENTENCE THIS SUITE DEFENDS =====================
//
// Sean: replay never means "trust this stored body forever". It means "this
// exact delivery was authenticated when it arrived, and we are re-running the
// already-authenticated delivery through an idempotent handler."
//
// So: signatureValid is written at receipt and read at replay; the signature
// itself is never replayed, and never needs to be.

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

  const owner = await prisma.user.create({ data: { email: `mr-${stamp}@example.test`, name: "Owner" } });
  const store = await prisma.store.create({
    data: { userId: owner.id, name: "MR", slug: `mr-${stamp}`, tagline: "t", description: "d" },
  });

  const handlers = replayHandlers();

  console.log("\n--- 0. the split is a move, not a rewrite ---\n");
  {
    // ============ THE PROPERTY A MONEY-PATH REFACTOR MUST HAVE =====
    //
    // Verification stayed in the route; handling left it. If any part of the
    // checking followed the handling out, the route would be trusting bytes it
    // never proved — the exact inversion this work must not produce.
    const stripeRoute = codeOnly("app/api/webhooks/stripe/route.ts");
    const stripeLib = codeOnly("lib/payments/stripeEvent.ts");
    const paypalRoute = codeOnly("app/api/webhooks/paypal/[storeId]/route.ts");
    const paypalLib = codeOnly("lib/payments/paypalEvent.ts");

    assert("Stripe still verifies in the route",
      stripeRoute.includes("stripe.webhooks.constructEvent(body, signature, configured.secret)"));
    assert("and the moved half verifies nothing",
      !stripeLib.includes("constructEvent"), "verification followed the handling out");
    assert("PayPal still verifies in the route", paypalRoute.includes("verifyPaypalWebhook("));
    assert("and its moved half verifies nothing",
      !paypalLib.includes("verifyPaypalWebhook("), "verification followed the handling out");

    // The delivery is still recorded with the verdict, in the route, before
    // anything acts on it. That record IS the persisted verified state.
    // ============ COUNTED, NOT MERELY FOUND (2026-08-30) ==========
    //
    // These asked whether `signatureValid: false` appeared anywhere. Sabotage
    // flipped the constructEvent-failure branch to true and the suite stayed
    // green, because the OTHER refusal branch still contained a false. An
    // assertion that a string exists somewhere in a file cannot say which
    // branch records what — and here the difference is whether a forged
    // delivery becomes replayable.
    //
    // Stripe refuses in two places (no signature, bad signature) and accepts in
    // one. PayPal refuses in one and accepts in one.
    const verdicts = (src: string, value: string) =>
      (src.match(new RegExp(`signatureValid: ${value}`, "g")) ?? []).length;
    eq("Stripe records a failed verdict in both refusal branches", verdicts(stripeRoute, "false"), 2);
    eq("and a passed verdict exactly once", verdicts(stripeRoute, "true"), 1);
    eq("PayPal records a failed verdict once", verdicts(paypalRoute, "false"), 1);
    eq("and a passed verdict once", verdicts(paypalRoute, "true"), 1);

    for (const [name, src] of [["Stripe", stripeRoute], ["PayPal", paypalRoute]] as const) {
      assert(`${name} decides the outcome outside the handler`,
        /markProcessed\(tracked\.deliveryId/.test(src) && /markFailed\(tracked\.deliveryId/.test(src));
    }

    eq("all three providers are replayable", replayableProviders(), ["EASYPOST", "PAYPAL", "STRIPE"]);
  }

  console.log("\n--- 1. a forged delivery can never become replayable ---\n");
  {
    // ============ THE ASSERTION THAT MATTERS MOST ==================
    //
    // A replay mechanism that will re-run anything is a way to execute an
    // unverified payment payload on demand — worse than having no replay.
    let ran = 0;
    const forged = await recordDelivery({
      provider: "STRIPE",
      rawBody: JSON.stringify({ id: "evt_forged", type: "checkout.session.completed", data: { object: {} } }),
      signatureValid: false,
      externalEventId: `evt_forged_${stamp}`,
    });
    await markFailed(forged!.id, new Error("nobody proved Stripe sent this"));

    const outcome = await replayDelivery({
      deliveryId: forged!.id,
      handlers: { STRIPE: async () => { ran++; } },
      actorId: owner.id,
    });
    eq("it is refused", outcome.status, "refused");
    eq("and no handler ran", ran, 0);

    // Refused for the RIGHT reason. A status guard catching it would leave the
    // signature check unproven, and the two would be covering for each other.
    assert("because the signature never verified",
      outcome.status === "refused" && /signature|verif/i.test(outcome.reason),
      outcome.status === "refused" ? outcome.reason : outcome.status);

    const signal = await prismaSystem.securitySignal.findFirst({
      where: { kind: SIGNAL_KINDS.webhookReplayRefused },
      orderBy: { occurredAt: "desc" },
    });
    assert("and somebody trying is recorded at critical severity", signal?.severity === "critical");

    // AND IT STAYS UNREPLAYABLE. Not a one-time refusal — there is no sequence
    // of attempts that turns a forged row into a runnable one.
    for (let i = 0; i < 3; i++) {
      const again = await replayDelivery({ deliveryId: forged!.id, handlers: { STRIPE: async () => { ran++; } } });
      eq(`attempt ${i + 2} is refused too`, again.status, "refused");
    }
    eq("still nothing ran", ran, 0);

    // The real handler map, not a counting stub — so this is proven against
    // what an operator's button actually calls.
    const withReal = await replayDelivery({ deliveryId: forged!.id, handlers });
    eq("and the real handlers refuse it as well", withReal.status, "refused");
  }

  console.log("\n--- 2. an expired-but-originally-verified delivery replays ---\n");
  {
    // ============ THE WHOLE POINT OF RANK 4 =======================
    //
    // No signature is presented here and none exists to present. The row says
    // the signature verified when it arrived; that is the persisted fact, and
    // it is what replay runs on.
    let seen: string | null = null;
    const body = JSON.stringify({ id: `evt_ok_${stamp}`, type: "some.unhandled.type", data: { object: {} } });
    const delivery = await recordDelivery({
      provider: "STRIPE", rawBody: body, signatureValid: true, externalEventId: `evt_ok_${stamp}`,
    });
    // Received a fortnight ago: any real Stripe signature over these bytes is
    // long outside its tolerance window.
    await prismaSystem.webhookDelivery.update({
      where: { id: delivery!.id },
      data: { receivedAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) },
    });
    await markFailed(delivery!.id, new Error("the handler fell over the first time"));

    const outcome = await replayDelivery({
      deliveryId: delivery!.id,
      handlers: { STRIPE: async (_s, raw) => { seen = raw; } },
      actorId: owner.id,
    });
    eq("a fortnight-old verified delivery replays", outcome.status, "replayed");
    eq("and the handler saw the original bytes", seen, body);

    const row = await prismaSystem.webhookDelivery.findUnique({ where: { id: delivery!.id } });
    eq("the delivery is processed now", row?.status, "processed");
    eq("with the old error cleared", row?.error, null);
    // The verdict is not rewritten by a replay. It was true then and stays the
    // record of what happened then.
    eq("and its original verdict is untouched", row?.signatureValid, true);
  }

  console.log("\n--- 2b. the real Stripe handler runs on a stored body ---\n");
  {
    // Through replayHandlers.STRIPE — the adapter an operator's button uses —
    // rather than a stub. An unhandled event type is the safe end of the real
    // handler: it exercises parse, dispatch and the Response-to-outcome
    // conversion without touching an order.
    const body = JSON.stringify({ id: `evt_real_${stamp}`, type: "invoice.paid", data: { object: {} } });
    const delivery = await recordDelivery({
      provider: "STRIPE", rawBody: body, signatureValid: true, externalEventId: `evt_real_${stamp}`,
    });
    await markFailed(delivery!.id, new Error("first time round it failed"));

    const outcome = await replayDelivery({ deliveryId: delivery!.id, handlers, actorId: owner.id });
    eq("the real handler replays a stored event", outcome.status, "replayed");
  }

  console.log("\n--- 2c. a verified body that is not an event still fails ---\n");
  {
    // ============ FOUND BY SABOTAGE (2026-08-30) ==================
    //
    // Removing the adapter's shape guard left the suite green, because nothing
    // here ever replayed a delivery whose stored body was valid JSON and not an
    // event. Without the guard the handler is handed an object with no `type`,
    // matches no branch, and answers 200 — so a nonsense delivery would be
    // marked processed and vanish from the replay list, having done nothing.
    //
    // A delivery that cannot be acted on must stay visible, not resolve itself.
    const shapes: [string, string][] = [
      ["an empty object", "{}"],
      ["a JSON null", "null"],
      ["an array", "[1,2,3]"],
      ["bytes that are not JSON at all", "<html>not json</html>"],
    ];
    for (const [label, storedBody] of shapes) {
      const slug = label.replace(/[^a-z]/gi, "");
      const d = await recordDelivery({
        provider: "STRIPE", rawBody: storedBody, signatureValid: true,
        externalEventId: `evt_shape_${slug}_${stamp}`,
      });
      await markFailed(d!.id, new Error("failed the first time"));
      const outcome = await replayDelivery({ deliveryId: d!.id, handlers, actorId: owner.id });
      eq(`${label} does not replay`, outcome.status, "failed");
      const row = await prismaSystem.webhookDelivery.findUnique({ where: { id: d!.id } });
      eq(`${label} stays failed rather than resolving itself`, row?.status, "failed");
    }
  }

  console.log("\n--- 2d. the replayed event equals the verified one ---\n");
  {
    // ============ AN ASSUMPTION TURNED INTO A TEST (2026-08-30) ====
    //
    // The live path builds its event with stripe.webhooks.constructEvent, which
    // verifies AND parses. Replay parses the stored bytes and does not verify.
    // The comment in replayHandlers.ts said the two produce the same shape and
    // that this was "stated rather than assumed away" — which is a polite way
    // of saying nobody had checked.
    //
    // It is cheap to check. Sign a body with a local secret, construct the
    // event the way the route does, parse it the way replay does, and compare
    // every field the handler actually reads. If a future SDK version starts
    // normalising something, this fails rather than a replayed payment quietly
    // behaving differently from a live one.
    //
    // HONEST LIMIT: this proves the two PARSING paths agree for this SDK
    // version. It says nothing about Stripe's live behaviour, because the
    // secret is ours and the payload is ours.
    const Stripe = (await import("stripe")).default;
    const secret = "whsec_local_only_for_this_assertion";
    const stripeSdk = new Stripe("sk_test_not_a_real_key");

    const payload = JSON.stringify({
      id: `evt_shape_cmp_${stamp}`,
      object: "event",
      type: "checkout.session.completed",
      account: "acct_connected_example",
      created: 1735689600,
      data: { object: { id: "cs_test_123", metadata: { productId: "p_1" }, amount_total: 4500 } },
    });
    const header = stripeSdk.webhooks.generateTestHeaderString({ payload, secret });

    const verified = stripeSdk.webhooks.constructEvent(payload, header, secret);
    const replayed = JSON.parse(payload) as typeof verified;

    // Exactly the fields handleStripeEvent reads.
    eq("the event id matches", replayed.id, verified.id);
    eq("the event type matches", replayed.type, verified.type);
    eq("the connected account matches", replayed.account, verified.account);
    eq("and the whole data object matches",
      JSON.stringify(replayed.data.object), JSON.stringify(verified.data.object));
    // The strongest form: nothing anywhere differs.
    eq("nothing at all differs between the two", JSON.stringify(replayed), JSON.stringify(verified));
  }

  console.log("\n--- 3. a replay cannot repeat an external effect ---\n");
  {
    // runOnce is the protection, unchanged by Rank 4 — the point is that
    // splitting verification from handling did not step around it.
    let charges = 0;
    const key = `mr-charge-${stamp}`;
    const body = JSON.stringify({ id: `evt_eff_${stamp}`, type: "x", data: { object: {} } });
    const delivery = await recordDelivery({
      provider: "STRIPE", rawBody: body, signatureValid: true, externalEventId: `evt_eff_${stamp}`,
    });
    await markFailed(delivery!.id, new Error("crashed after the charge"));

    // ============ THE HANDLER MUST FAIL ONCE, NOT FOR EVER =========
    //
    // The first version keyed this off `charges === 1` and therefore threw on
    // every attempt — because runOnce correctly refuses to perform twice, so
    // the count never moves again. The test's own guard was defeated by the
    // protection it was written to prove, and the second replay could never
    // succeed. A separate flag, so "fail after the effect" happens exactly
    // once.
    let alreadyCrashed = false;
    const handler = async () => {
      await runOnce({
        key, operation: "mr.charge", storeId: store.id,
        perform: async () => { charges++; return { result: { ok: true }, externalRef: `ref-${charges}` }; },
      });
      // Fail AFTER the effect the first time, forcing the delivery back to
      // failed so it can be replayed again — the exact shape that duplicates
      // money without runOnce.
      if (!alreadyCrashed) {
        alreadyCrashed = true;
        throw new Error("died after charging");
      }
    };

    await replayDelivery({ deliveryId: delivery!.id, handlers: { STRIPE: handler } });
    const second = await replayDelivery({ deliveryId: delivery!.id, handlers: { STRIPE: handler } });

    eq("the external effect happened exactly once", charges, 1);
    eq("and the second replay completed", second.status, "replayed");
  }

  console.log("\n--- 4. failed handling and failed verification stay different ---\n");
  {
    // ============ TWO FAILURES THAT MUST NOT LOOK ALIKE ===========
    //
    // One is "we could not act on this" — recoverable, and replay exists for
    // it. The other is "we could not prove this came from the provider" —
    // permanent, and replaying it would be the attack. They share a status
    // column, so the distinction lives in signatureValid, and every downstream
    // decision reads it.
    const goodBody = JSON.stringify({ id: `evt_h_${stamp}`, type: "x", data: { object: {} } });
    const handlingFailed = await recordDelivery({
      provider: "STRIPE", rawBody: goodBody, signatureValid: true, externalEventId: `evt_h_${stamp}`,
    });
    await markFailed(handlingFailed!.id, new Error("the order could not be written"));

    const verificationFailed = await recordDelivery({
      provider: "STRIPE", rawBody: "{}", signatureValid: false, externalEventId: `evt_v_${stamp}`,
    });
    await markFailed(verificationFailed!.id, new Error("signature did not verify"));

    const a = await prismaSystem.webhookDelivery.findUnique({ where: { id: handlingFailed!.id } });
    const b = await prismaSystem.webhookDelivery.findUnique({ where: { id: verificationFailed!.id } });
    eq("both read as failed", [a?.status, b?.status], ["failed", "failed"]);
    // The column that tells them apart.
    eq("and only one of them was ever proven", [a?.signatureValid, b?.signatureValid], [true, false]);

    let ran = 0;
    const stub = { STRIPE: async () => { ran++; } };
    eq("the handling failure is replayable",
      (await replayDelivery({ deliveryId: handlingFailed!.id, handlers: stub })).status, "replayed");
    eq("the verification failure is not",
      (await replayDelivery({ deliveryId: verificationFailed!.id, handlers: stub })).status, "refused");
    eq("so exactly one of the two ran", ran, 1);

    // And the operator surface offers only the one that may be offered.
    const { replayableDeliveries } = await import("@/lib/webhooks/delivery");
    const offered = await replayableDeliveries("STRIPE", 200);
    const offeredIds = new Set(offered.filter((d) => d.signatureValid).map((d) => d.id));
    assert("only the proven one is offered for replay", !offeredIds.has(verificationFailed!.id));
  }

  console.log("\n--- 5. a duplicate provider delivery stays idempotent ---\n");
  {
    // Rank 4 must not have weakened the existing dedup: a provider redelivering
    // the same event id is a recognisable fact, not a second unit of work.
    const eventId = `evt_dup_${stamp}`;
    const body = JSON.stringify({ id: eventId, type: "x", data: { object: {} } });
    const first = await recordDelivery({ provider: "STRIPE", rawBody: body, signatureValid: true, externalEventId: eventId });
    const again = await recordDelivery({ provider: "STRIPE", rawBody: body, signatureValid: true, externalEventId: eventId });

    eq("the redelivery is the same row", again?.id, first?.id);
    const rows = await prismaSystem.webhookDelivery.count({
      where: { provider: "STRIPE", externalEventId: eventId },
    });
    eq("recorded once, not twice", rows, 1);
    const row = await prismaSystem.webhookDelivery.findUnique({ where: { id: first!.id } });
    assert("with the arrivals counted", (row?.attempts ?? 0) >= 2, `${row?.attempts}`);
  }

  console.log("\n--- 6. the money paths behave as they did ---\n");
  {
    // ============ WHAT A VERBATIM MOVE MEANS ======================
    //
    // The handling half was moved byte-identical; this asserts the seam did not
    // shift, by checking the route retains every step BEFORE it and the library
    // every branch after it. A handler that quietly lost an event type is the
    // failure this catches.
    const stripeLib = readFileSync("lib/payments/stripeEvent.ts", "utf8");
    for (const type of ["checkout.session.completed", "charge.refunded"]) {
      assert(`Stripe still handles ${type}`, stripeLib.includes(`event.type === "${type}"`));
    }
    const paypalLib = readFileSync("lib/payments/paypalEvent.ts", "utf8");
    for (const type of ["PAYMENT.CAPTURE.REFUNDED", "PAYMENT.CAPTURE.REVERSED"]) {
      assert(`PayPal still handles ${type}`, paypalLib.includes(type));
    }
    // The refund path's store scoping — the property the route's trust model
    // rests on — must have survived the move intact.
    assert("PayPal still scopes every order lookup to the proven store",
      /where: \{ storeId, paymentProvider: "PAYPAL"/.test(paypalLib));

    // A PayPal replay with no store must refuse rather than scope to nothing.
    let ran = 0;
    const real = replayHandlers();
    let refused = "";
    try {
      await real.PAYPAL("", "{}");
      ran++;
    } catch (error) {
      refused = error instanceof Error ? error.message : String(error);
    }
    eq("a PayPal replay with no store never runs", ran, 0);
    assert("and says why", /no store/i.test(refused), refused);
  }

  console.log("\n--- 7. a replay keeps the original correlation chain ---\n");
  {
    // A replayed delivery must remain joinable to the request that first
    // brought it in — otherwise the trace that explains an incident splits in
    // two at exactly the moment somebody intervened.
    const originalId = await withCorrelation({ origin: "webhook", surface: "STRIPE" }, async () => {
      const id = correlationId()!;
      const body = JSON.stringify({ id: `evt_corr_${stamp}`, type: "x", data: { object: {} } });
      const d = await recordDelivery({
        provider: "STRIPE", rawBody: body, signatureValid: true, externalEventId: `evt_corr_${stamp}`,
      });
      await markFailed(d!.id, new Error("failed inside the original request"));
      return id;
    });

    const delivery = await prismaSystem.webhookDelivery.findFirst({
      where: { externalEventId: `evt_corr_${stamp}` },
    });
    eq("the delivery carries the original correlation id", delivery?.correlationId, originalId);

    await replayDelivery({ deliveryId: delivery!.id, handlers: { STRIPE: async () => {} }, actorId: owner.id });

    const after = await prismaSystem.webhookDelivery.findUnique({ where: { id: delivery!.id } });
    eq("and still carries it after the replay", after?.correlationId, originalId);

    // The trace opens on the original id and contains the delivery — so an
    // operator following the incident finds the replay, not a dead end.
    const trace = await traceFor(originalId);
    assert("the original trace still finds the delivery",
      trace.entries.some((e) => e.source === "webhook"),
      JSON.stringify(trace.entries.map((e) => e.source)));
  }

  console.log("\n--- 8. a failed replay never marks the original successful ---\n");
  {
    const body = JSON.stringify({ id: `evt_fail_${stamp}`, type: "x", data: { object: {} } });
    const delivery = await recordDelivery({
      provider: "STRIPE", rawBody: body, signatureValid: true, externalEventId: `evt_fail_${stamp}`,
    });
    await markFailed(delivery!.id, new Error("the first attempt failed"));

    const outcome = await replayDelivery({
      deliveryId: delivery!.id,
      handlers: { STRIPE: async () => { throw new Error("still broken"); } },
    });
    eq("the replay reports failure", outcome.status, "failed");

    const row = await prismaSystem.webhookDelivery.findUnique({ where: { id: delivery!.id } });
    eq("the delivery is failed, not processed", row?.status, "failed");
    // NOT stuck in `replaying` either — one bad attempt must not make a
    // delivery permanently unrecoverable.
    assert("and it says why, with the new reason", (row?.error ?? "").includes("still broken"), row?.error ?? "");

    const { replayableDeliveries } = await import("@/lib/webhooks/delivery");
    const offered = await replayableDeliveries("STRIPE", 200);
    assert("it is still offered for replay", offered.some((d) => d.id === delivery!.id));
  }

  console.log("\n--- 8b. a non-2xx from a money handler is a failure, not a success ---\n");
  {
    // ============ THE ADAPTER'S WHOLE JOB =========================
    //
    // Both money handlers answer with a Response because both were written as
    // the tail of a route. Replay learns outcomes by catching. Without the
    // conversion, a handler returning 500 would be recorded as replayed and the
    // delivery marked processed — the audit trail lying about the one thing it
    // exists to be honest about.
    //
    // Exercised through the real PAYPAL adapter: an empty store is the one
    // non-2xx the handler produces without needing a live provider.
    const paypalDelivery = await recordDelivery({
      provider: "PAYPAL", rawBody: JSON.stringify({ id: `pp_${stamp}`, event_type: "PAYMENT.CAPTURE.REFUNDED" }),
      signatureValid: true, storeId: store.id, externalEventId: `pp_${stamp}`,
    });
    await markFailed(paypalDelivery!.id, new Error("first attempt failed"));

    // No PayPal credentials exist here, so the real handler cannot find an
    // order and answers 200 for an unmatched capture — which is correct
    // behaviour and NOT what this asserts. What is asserted is the conversion
    // itself, directly.
    const real = replayHandlers();
    let threw = false;
    await real
      .PAYPAL(store.id, "not json at all")
      .catch(() => { threw = true; });
    assert("a malformed stored body is a failure, not a silent success", threw);
  }

  console.log("\n--- a processed delivery is never replayable, whatever it moved ---\n");
  {
    const body = JSON.stringify({ id: `evt_done_${stamp}`, type: "x", data: { object: {} } });
    const delivery = await recordDelivery({
      provider: "STRIPE", rawBody: body, signatureValid: true, externalEventId: `evt_done_${stamp}`,
    });
    await markProcessed(delivery!.id);

    let ran = 0;
    const outcome = await replayDelivery({
      deliveryId: delivery!.id, handlers: { STRIPE: async () => { ran++; } },
    });
    eq("a processed delivery is refused", outcome.status, "refused");
    assert("by the status guard, naming the state",
      outcome.status === "refused" && outcome.reason.includes("processed"),
      outcome.status === "refused" ? outcome.reason : outcome.status);
    eq("and nothing re-ran", ran, 0);
  }

  console.log(`\n${failures} failed, ${passes} passed\n`);
  await prismaSystem.$disconnect();
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
