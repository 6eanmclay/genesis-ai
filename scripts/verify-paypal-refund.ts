import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";

// PayPal refunds, against a real database:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-paypal-refund.ts" -OutFile out.txt
//
// The last piece of VISION.md's P0.3 — "refunds/status changes are handled" —
// on the rail that had no refund path at all (COMPLIANCE.md §41).
//
// The REAL route handler runs against a real Postgres. Only PayPal's own HTTP
// responses are supplied, and the one that matters is
// verify-webhook-signature: the stub answers SUCCESS **only** when the
// webhook_id in the request matches the one the event was signed for. That is
// what makes the forgery and cross-tenant cases below mean something — they
// fail for the same reason they would in production, not because a flag was
// flipped.

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}

function assert(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

/** The webhook id PayPal would accept a signature for. Nothing else verifies. */
let signedForWebhookId = "";

function installPaypalStub() {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;

    if (url.includes("/v1/oauth2/token")) {
      return new Response(JSON.stringify({ access_token: "A-TOKEN" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/v1/notifications/verify-webhook-signature")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const status = body.webhook_id === signedForWebhookId ? "SUCCESS" : "FAILURE";
      return new Response(JSON.stringify({ verification_status: status }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return real(input as never, init);
  }) as typeof fetch;
}

function refundEvent(opts: {
  captureId: string;
  amount?: string;
  totalRefunded?: string;
  createTime?: string;
  eventType?: string;
}) {
  return {
    id: "WH-EVENT-1",
    event_type: opts.eventType ?? "PAYMENT.CAPTURE.REFUNDED",
    create_time: opts.createTime ?? new Date().toISOString(),
    resource: {
      id: "REFUND-1",
      status: "COMPLETED",
      amount: { value: opts.amount ?? "25.00", currency_code: "USD" },
      ...(opts.totalRefunded
        ? { seller_payable_breakdown: { total_refunded_amount: { value: opts.totalRefunded } } }
        : {}),
      links: [
        { rel: "self", href: `https://api-m.sandbox.paypal.com/v2/payments/refunds/REFUND-1` },
        { rel: "up", href: `https://api-m.sandbox.paypal.com/v2/payments/captures/${opts.captureId}` },
      ],
    },
  };
}

const SIGNED_HEADERS = {
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
  "paypal-transmission-id": "TRANSMISSION-1",
  "paypal-transmission-sig": "a-signature",
  "paypal-transmission-time": "2026-08-20T12:00:00Z",
};

async function main() {
  const db = await startRealPostgres();
  await db.prisma.$disconnect();

  process.env[TEST_DATABASE_ENV] = "1";
  process.env.DATABASE_URL = db.url;
  process.env.INTEGRATION_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

  installPaypalStub();

  const { NextRequest } = await import("next/server");
  const { POST } = await import("@/app/api/webhooks/paypal/[storeId]/route");
  const { prismaSystem: prisma } = await import("@/lib/prisma");
  const { encryptCredentials } = await import("@/lib/integrations/credentials");
  const { purchaseShippingLabelExecutable } = await import("@/lib/execution/executables/shipping");

  const deliver = async (
    storeId: string,
    event: unknown,
    opts: { headers?: Record<string, string> } = {}
  ) => {
    const request = new NextRequest(`https://shop.example.test/api/webhooks/paypal/${storeId}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(opts.headers ?? SIGNED_HEADERS) },
      body: JSON.stringify(event),
    });
    const res = await POST(request, { params: Promise.resolve({ storeId }) });
    return { status: res.status, body: await res.text() };
  };

  async function reset() {
    const tables = await prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename <> '_prisma_migrations'
        AND tablename <> '_genesis_test_database'`;
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`
    );
  }

  async function makeStore(
    slug: string,
    opts: { webhookId?: string | null; captureId?: string; amountInCents?: number } = {}
  ) {
    const user = await prisma.user.create({ data: { email: `${slug}@example.test` } });
    const store = await prisma.store.create({
      data: { userId: user.id, name: `${slug} shop`, slug, tagline: "t", description: "d", published: true },
    });
    await prisma.storeIntegration.create({
      data: {
        storeId: store.id,
        provider: "PAYPAL",
        status: "CONNECTED",
        externalAccountId: `client_${slug}`,
        credentials: encryptCredentials({
          schemaVersion: 1,
          clientId: `client_${slug}`,
          clientSecret: "secret",
          environment: "sandbox",
          webhookId: opts.webhookId === undefined ? `WH-${slug}` : opts.webhookId,
        }),
      },
    });
    const product = await prisma.product.create({
      data: { storeId: store.id, name: `${slug} candle`, description: "d", priceInCents: 2500, active: true },
    });
    const order = await prisma.order.create({
      data: {
        storeId: store.id,
        productId: product.id,
        productName: product.name,
        amountInCents: opts.amountInCents ?? 2500,
        buyerEmail: "buyer@example.test",
        status: "paid",
        paymentProvider: "PAYPAL",
        externalOrderId: `PP-${slug}`,
        externalPaymentId: opts.captureId ?? `CAPTURE-${slug}`,
      },
    });
    return { store, product, order };
  }

  const statusOf = async (id: string) =>
    (await prisma.order.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;

  try {
    // -----------------------------------------------------------------------
    console.log("\n1. A real refund is recorded as one");
    {
      await reset();
      const { store, order } = await makeStore("refunded");
      signedForWebhookId = "WH-refunded";

      const res = await deliver(store.id, refundEvent({ captureId: "CAPTURE-refunded" }));
      check("acknowledged", res.status, 200);
      check("and the order says so", await statusOf(order.id), "refunded");

      // WHAT THAT ACTUALLY BUYS. Every consumer of this decision reads
      // Order.status, so until this route existed none of them could be right
      // about a PayPal sale. The one that costs real money is the label guard.
      const label = await purchaseShippingLabelExecutable
        .run({ orderId: order.id, weightOz: 8 }, { storeId: store.id, userId: null, actorType: "USER" })
        .then(() => null)
        .catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
      assert(
        "so the owner can no longer post the goods at their own expense",
        (label ?? "").toLowerCase().includes("refunded"),
        String(label)
      );
    }

    // -----------------------------------------------------------------------
    console.log("\n2. A forged refund changes nothing");
    {
      await reset();
      const { store, order } = await makeStore("forged");
      // The attacker knows the store id and the capture id. What they do not
      // have is a signature PayPal will vouch for.
      signedForWebhookId = "WH-some-other-app";

      const res = await deliver(store.id, refundEvent({ captureId: "CAPTURE-forged" }));
      check("refused", res.status, 400);
      check("as permanently bad, so it is not retried forever", res.body, "Invalid signature");
      check("and the order is untouched", await statusOf(order.id), "paid");

      // Unsigned entirely is the same answer, and must not reach PayPal at all.
      signedForWebhookId = "WH-forged";
      const bare = await deliver(store.id, refundEvent({ captureId: "CAPTURE-forged" }), { headers: {} });
      check("a delivery with no signature headers is refused", bare.status, 400);
      check("and still changes nothing", await statusOf(order.id), "paid");

      // THE POSITIVE CONTROL, and the reason the two refusals above mean
      // anything. The byte-identical body, now signed for this store's own
      // webhook, lands — so what was refused was the signature and nothing else.
      // Without this a suite could assert 400 forever while the route rejected
      // every delivery for some entirely different reason.
      const signed = await deliver(store.id, refundEvent({ captureId: "CAPTURE-forged" }), {
        headers: SIGNED_HEADERS,
      });
      check("the same event, properly signed, is accepted", signed.status, 200);
      check("and this time the refund lands", await statusOf(order.id), "refunded");
    }

    // -----------------------------------------------------------------------
    console.log("\n3. One store's refund cannot be applied to another");
    {
      await reset();
      const a = await makeStore("tenant-a");
      const b = await makeStore("tenant-b");
      // A genuine event for store A, replayed at store B's URL. It verifies
      // against A's webhook id and nothing else, so B's endpoint refuses it.
      signedForWebhookId = "WH-tenant-a";

      const crossed = await deliver(b.store.id, refundEvent({ captureId: "CAPTURE-tenant-a" }));
      check("refused at the other store's endpoint", crossed.status, 400);
      check("store A's order is untouched", await statusOf(a.order.id), "paid");
      check("and store B's is too", await statusOf(b.order.id), "paid");

      // Even verified for B, a capture that is not B's matches no order of B's.
      signedForWebhookId = "WH-tenant-b";
      const foreign = await deliver(
        b.store.id,
        refundEvent({ captureId: "CAPTURE-tenant-a", createTime: "2020-01-01T00:00:00Z" })
      );
      check("a verified event naming another store's capture applies to nothing", foreign.status, 200);
      check("store A is still paid", await statusOf(a.order.id), "paid");
      check("store B is still paid", await statusOf(b.order.id), "paid");
      // But it is not silent — money left the merchant's PayPal account.
      const recorded = await prisma.executionLog.findMany({
        where: { storeId: b.store.id, action: "checkout.paypal.refund_unapplied" },
      });
      check("the owner has a record to reconcile against", recorded.length, 1);
    }

    // -----------------------------------------------------------------------
    console.log("\n4. A store with no webhook is a misconfiguration, not an attack");
    {
      await reset();
      const { store, order } = await makeStore("no-webhook", { webhookId: null });
      signedForWebhookId = "WH-anything";

      const res = await deliver(store.id, refundEvent({ captureId: "CAPTURE-no-webhook" }));
      // NOT 400. 400 tells PayPal to give up, and this store has done nothing
      // wrong — it connected before refund webhooks existed. 404 keeps the
      // delivery coming, so reconnecting collects the backlog.
      check("not told to give up", res.status, 404);
      check("the order is unchanged for now", await statusOf(order.id), "paid");

      // And once it reconnects, the same delivery lands.
      await prisma.storeIntegration.update({
        where: { storeId_provider: { storeId: store.id, provider: "PAYPAL" } },
        data: {
          credentials: (await import("@/lib/integrations/credentials")).encryptCredentials({
            schemaVersion: 1,
            clientId: "client_no-webhook",
            clientSecret: "secret",
            environment: "sandbox",
            webhookId: "WH-anything",
          }),
        },
      });
      const retried = await deliver(store.id, refundEvent({ captureId: "CAPTURE-no-webhook" }));
      check("the retry is accepted", retried.status, 200);
      check("and the refund finally lands", await statusOf(order.id), "refunded");
    }

    // -----------------------------------------------------------------------
    console.log("\n5. Partial refunds, and the point at which they stop being partial");
    {
      await reset();
      const { store, order } = await makeStore("partial");
      signedForWebhookId = "WH-partial";

      const half = await deliver(
        store.id,
        refundEvent({ captureId: "CAPTURE-partial", amount: "10.00", totalRefunded: "10.00" })
      );
      check("acknowledged", half.status, 200);
      // Deliberate, and identical to the Stripe rail: a partly refunded order
      // still has goods to ship, and calling it "refunded" would tell the owner
      // to stop. The gap this leaves is named in COMPLIANCE.md's close-out.
      check("a partial refund does not relabel the order", await statusOf(order.id), "paid");

      // The cumulative total is what makes two halves add up. Sending only this
      // refund's own amount would leave the order looking part-paid forever.
      const rest = await deliver(
        store.id,
        refundEvent({ captureId: "CAPTURE-partial", amount: "15.00", totalRefunded: "25.00" })
      );
      check("acknowledged", rest.status, 200);
      check("and the second half completes it", await statusOf(order.id), "refunded");
    }

    // -----------------------------------------------------------------------
    console.log("\n6. A redelivery is a no-op, not a second write");
    {
      await reset();
      const { store, order } = await makeStore("replay");
      signedForWebhookId = "WH-replay";
      const event = refundEvent({ captureId: "CAPTURE-replay" });

      // PayPal redelivers, and two deliveries can race. A check-then-act would
      // let both read "paid" and both write.
      const results = await Promise.all([
        deliver(store.id, event),
        deliver(store.id, event),
        deliver(store.id, event),
      ]);
      check("all acknowledged", results.map((r) => r.status), [200, 200, 200]);
      check("refunded", await statusOf(order.id), "refunded");

      const later = await deliver(store.id, event);
      check("and a delivery days later is still fine", later.status, 200);
      check("still refunded, once", await statusOf(order.id), "refunded");
    }

    // -----------------------------------------------------------------------
    console.log("\n7. A refund that beats its own order into the database");
    {
      await reset();
      const { store } = await makeStore("race");
      signedForWebhookId = "WH-race";

      // The capture route writes the order AFTER PayPal takes the money, so a
      // refund issued moments later can genuinely arrive first. Inside that
      // window the answer must keep PayPal coming back.
      const fresh = await deliver(store.id, refundEvent({ captureId: "CAPTURE-not-written-yet" }));
      check("asks PayPal to try again", fresh.status, 503);
      check("and does not write a premature failure",
        (await prisma.executionLog.findMany({ where: { storeId: store.id, action: "checkout.paypal.refund_unapplied" } })).length,
        0);

      // Outside it, nothing is coming. Retrying for three days only delays
      // somebody looking at real money that left the merchant's account.
      const old = await deliver(
        store.id,
        refundEvent({ captureId: "CAPTURE-never-arrives", createTime: "2020-01-01T00:00:00Z" })
      );
      check("an old one is accepted and recorded instead", old.status, 200);
      const recorded = await prisma.executionLog.findMany({
        where: { storeId: store.id, action: "checkout.paypal.refund_unapplied" },
      });
      check("exactly one record", recorded.length, 1);
      assert("naming the capture, so it can be reconciled",
        (recorded[0]?.message ?? "").includes("CAPTURE-never-arrives"), recorded[0]?.message ?? "");
    }

    // -----------------------------------------------------------------------
    console.log("\n8. Events this endpoint does not act on");
    {
      await reset();
      const { store, order } = await makeStore("other-events");
      signedForWebhookId = "WH-other-events";

      const completed = await deliver(
        store.id,
        refundEvent({ captureId: "CAPTURE-other-events", eventType: "PAYMENT.CAPTURE.COMPLETED" })
      );
      check("an unsubscribed event is acknowledged, not retried", completed.status, 200);
      check("and changes nothing", await statusOf(order.id), "paid");

      // A reversal is a refund by another name, and must act like one.
      const reversed = await deliver(
        store.id,
        refundEvent({ captureId: "CAPTURE-other-events", eventType: "PAYMENT.CAPTURE.REVERSED" })
      );
      check("a reversal is acted on", reversed.status, 200);
      check("and the money is recorded as gone", await statusOf(order.id), "refunded");
    }

    // -----------------------------------------------------------------------
    console.log("\n9. A refund naming no capture at all");
    {
      await reset();
      const { store, order } = await makeStore("no-capture");
      signedForWebhookId = "WH-no-capture";

      const res = await deliver(store.id, {
        id: "WH-EVENT-X",
        event_type: "PAYMENT.CAPTURE.REFUNDED",
        create_time: new Date().toISOString(),
        resource: { id: "REFUND-X", amount: { value: "25.00" }, links: [] },
      });
      // Retrying an identical payload cannot produce a capture id.
      check("acknowledged rather than retried forever", res.status, 200);
      check("and nothing is guessed at", await statusOf(order.id), "paid");
    }
  } finally {
    await prisma.$disconnect().catch(() => {});
    await db.close();
  }

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
