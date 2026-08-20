import Stripe from "stripe";
import { startTestServer } from "@/scripts/lib/testServer";

// The merchant webhook's ORDER-CREATION branch, over real HTTP.
//
//   npx tsx scripts/verify-order-webhook-live.ts
//
// This is the one path on the money route that nothing else could reach. It
// ends in Next's `after()`, which throws outside a request scope, so calling the
// exported POST directly stops short of it. Everything here goes through a real
// Next server: real routing, real request scope, real `after()`, real Postgres.
//
// WHAT IS DELIBERATELY NOT DONE, because each would have made the test a lie:
// the production connection pool is untouched, `after()` is not stubbed, the
// handler is not bypassed, the database is not mocked, and the production guard
// is intact — the server is proven to be on the test database before a single
// webhook is sent (scripts/lib/testServer.ts).
//
// The assertions are about DATABASE STATE, not status codes alone. A 200 that
// wrote nothing is exactly the failure this whole audit has been chasing.

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

const MERCHANT_SECRET = "whsec_harness_merchant";

async function main() {
  console.log("Starting a real Next server on a real Postgres. First compile takes a while.\n");
  const server = await startTestServer();
  const prisma = server.db.prisma;
  const stripe = new Stripe("sk_test_harness");
  const webhookUrl = `${server.baseUrl}/api/webhooks/stripe`;

  /** Post a genuinely Stripe-signed event over HTTP, exactly as Stripe would. */
  async function postEvent(event: unknown, secret = MERCHANT_SECRET): Promise<Response> {
    const payload = JSON.stringify(event);
    return fetch(webhookUrl, {
      method: "POST",
      headers: {
        "stripe-signature": stripe.webhooks.generateTestHeaderString({ payload, secret }),
        "content-type": "application/json",
      },
      body: payload,
    });
  }

  async function seedStore(slug: string) {
    const user = await prisma.user.create({ data: { email: `${slug}@example.test` } });
    const store = await prisma.store.create({
      data: { userId: user.id, name: slug, slug, tagline: "t", description: "d" },
    });
    const product = await prisma.product.create({
      data: { storeId: store.id, name: "Hand-poured Candle", description: "d", priceInCents: 2500, active: true },
    });
    return { store, product };
  }

  const completedSession = (params: {
    sessionId: string;
    storeId: string;
    productId: string;
    withShipping?: boolean;
  }) => ({
    id: `evt_${params.sessionId}`,
    type: "checkout.session.completed",
    data: {
      object: {
        id: params.sessionId,
        amount_total: 3392,
        payment_intent: `pi_${params.sessionId}`,
        customer_details: { email: "sarah@example.test" },
        metadata: {
          storeId: params.storeId,
          productId: params.productId,
          ...(params.withShipping
            ? {
                shippingCarrier: "USPS",
                shippingService: "Priority Mail",
                shippingRateId: "rate_priority",
                shippingAmountInCents: "892",
                shippingEstDays: "2",
                shippingAddress: JSON.stringify({
                  name: "Sarah Chen",
                  line1: "1600 Pearl St",
                  city: "Boulder",
                  state: "CO",
                  postalCode: "80302",
                  country: "US",
                }),
              }
            : {}),
        },
      },
    },
  });

  try {
    // -----------------------------------------------------------------------
    console.log("\n1. A real payment becomes exactly one Order, with its BusinessEvent");
    {
      await server.db.reset();
      const { store, product } = await seedStore("live-shop");
      const sessionId = "cs_live_order_1";

      const response = await postEvent(
        completedSession({ sessionId, storeId: store.id, productId: product.id, withShipping: true })
      );
      check("Stripe is acknowledged", response.status, 200);

      const orders = await prisma.order.findMany({ where: { storeId: store.id } });
      check("exactly one Order exists", orders.length, 1);

      const order = orders[0];
      // The store/product relationship is the thing a wrong resolution would
      // silently corrupt, so it is asserted rather than assumed from the 200.
      check("it belongs to the right store", order.storeId, store.id);
      check("and the right product", order.productId, product.id);
      check("with the product's real name, not a placeholder", order.productName, "Hand-poured Candle");
      check("the amount Stripe reported", order.amountInCents, 3392);
      check("the buyer's email", order.buyerEmail, "sarah@example.test");
      check("marked paid", order.status, "paid");
      check("the charge id, which refunds match on", order.externalPaymentId, `pi_${sessionId}`);

      // Shipping arrives in metadata when the customer chose a service on the
      // storefront — Stripe was never asked to collect the address again.
      check("the chosen carrier", order.selectedShippingCarrier, "USPS");
      check("the chosen service", order.selectedShippingService, "Priority Mail");
      check("what the customer paid to ship", order.shippingChargedInCents, 892);
      check("the delivery estimate", order.selectedShippingEstDays, 2);
      check("the rate id, so the exact quote can be bought", order.selectedShippingRateId, "rate_priority");
      const address = order.shippingAddress as { city?: string; postalCode?: string } | null;
      check("and the address they typed", [address?.city, address?.postalCode], ["Boulder", "80302"]);

      // The BusinessEvent commits in the SAME transaction as the Order. If one
      // exists without the other, the intelligence engine's view of the
      // business silently diverges from its money.
      const events = await prisma.businessEvent.findMany({ where: { storeId: store.id } });
      check("one BusinessEvent was written", events.length, 1);
      check("describing a created transaction", events[0].eventType, "transaction.created");
      assert("naming the product", events[0].summary.includes("Hand-poured Candle"), events[0].summary);
      assert("and the amount", events[0].summary.includes("33.92"), events[0].summary);
    }

    // -----------------------------------------------------------------------
    console.log("\n2. Replaying the same event creates nothing further");
    {
      const store = await prisma.store.findFirstOrThrow({ where: { slug: "live-shop" } });
      const product = await prisma.product.findFirstOrThrow({ where: { storeId: store.id } });
      const event = completedSession({
        sessionId: "cs_live_order_1",
        storeId: store.id,
        productId: product.id,
        withShipping: true,
      });

      // Stripe redelivers on timeouts, on non-2xx, and sometimes for no reason
      // at all. Three more deliveries of the event already handled above.
      for (let i = 0; i < 3; i++) {
        check(`replay ${i + 1} is acknowledged`, (await postEvent(event)).status, 200);
      }

      check("still exactly one Order", await prisma.order.count({ where: { storeId: store.id } }), 1);
      check("and still one BusinessEvent", await prisma.businessEvent.count({ where: { storeId: store.id } }), 1);

      // A genuinely different session must still create an order, or
      // idempotency has been keyed on something too broad and real sales vanish.
      await postEvent(completedSession({ sessionId: "cs_live_order_2", storeId: store.id, productId: product.id }));
      check("a different session creates a second Order", await prisma.order.count({ where: { storeId: store.id } }), 2);
    }

    // -----------------------------------------------------------------------
    console.log("\n3. A forged or unsigned request creates nothing");
    {
      await server.db.reset();
      const { store, product } = await seedStore("forged");
      const event = completedSession({ sessionId: "cs_forged", storeId: store.id, productId: product.id });

      const unsigned = await fetch(webhookUrl, { method: "POST", body: JSON.stringify(event) });
      check("no signature is rejected", unsigned.status, 400);

      check("a wrong-secret signature is rejected", (await postEvent(event, "whsec_attacker")).status, 400);

      // A payload edited after signing — the amount inflated.
      const payload = JSON.stringify(event);
      const header = stripe.webhooks.generateTestHeaderString({ payload, secret: MERCHANT_SECRET });
      const tampered = await fetch(webhookUrl, {
        method: "POST",
        headers: { "stripe-signature": header },
        body: payload.replace("3392", "1"),
      });
      check("a tampered payload is rejected", tampered.status, 400);

      // 400 is correct here and 500 would be wrong: a forgery is permanently
      // bad, and telling Stripe to retry it forever would be the wrong answer.
      check("and no Order was created by any of them", await prisma.order.count(), 0);
    }

    // -----------------------------------------------------------------------
    console.log("\n4. A payment for a store that no longer exists");
    {
      await server.db.reset();
      const { store, product } = await seedStore("deleted");
      const deletedStoreId = store.id;
      const deletedProductId = product.id;
      await prisma.store.delete({ where: { id: store.id } });

      const response = await postEvent(
        completedSession({ sessionId: "cs_deleted_store", storeId: deletedStoreId, productId: deletedProductId })
      );

      // The defect this audit found: the foreign key violation used to throw out
      // of POST, so Next answered 500, Stripe retried for days against something
      // that could never succeed, and then gave up.
      check("acknowledged rather than retried forever", response.status, 200);
      assert("specifically not a 500", response.status !== 500, String(response.status));
      check("and no Order exists", await prisma.order.count(), 0);
    }

    // -----------------------------------------------------------------------
    console.log("\n5. A payment naming a product that does not exist");
    {
      await server.db.reset();
      const { store } = await seedStore("no-product");

      const response = await postEvent(
        completedSession({ sessionId: "cs_ghost_product", storeId: store.id, productId: "prod_does_not_exist" })
      );
      check("acknowledged", response.status, 200);

      // The money is real whatever the catalogue says, so the Order is still
      // created — with an honest placeholder rather than a borrowed name.
      const orders = await prisma.order.findMany({ where: { storeId: store.id } });
      check("the Order is still created, because the money is real", orders.length, 1);
      check("named honestly", orders[0].productName, "Unknown product");
      check("with no product linked, rather than a dangling id", orders[0].productId, null);
      check("and the amount preserved", orders[0].amountInCents, 3392);
    }

    // -----------------------------------------------------------------------
    console.log("\n6. A payment carrying no product at all");
    {
      await server.db.reset();
      const { store } = await seedStore("no-metadata");

      const response = await postEvent({
        id: "evt_no_product",
        type: "checkout.session.completed",
        data: { object: { id: "cs_no_product", amount_total: 5000, metadata: { storeId: store.id } } },
      });
      check("acknowledged", response.status, 200);
      check("no Order invented", await prisma.order.count(), 0);

      // The owner must be able to see that money arrived and produced nothing.
      const recorded = await prisma.executionLog.findMany({ where: { storeId: store.id, status: "FAILED" } });
      check("the owner gets a durable record", recorded.length, 1);
      assert("naming the session", recorded[0].message.includes("cs_no_product"), recorded[0].message);
      assert("and telling them to reconcile it", recorded[0].message.toLowerCase().includes("reconcile"));
    }

    // -----------------------------------------------------------------------
    console.log("\n7. A cross-store claim lands nowhere useful");
    {
      await server.db.reset();
      const victim = await seedStore("victim");
      const attacker = await seedStore("attacker");
      await prisma.storeIntegration.create({
        data: { storeId: victim.store.id, provider: "STRIPE", status: "CONNECTED", externalAccountId: "acct_victim" },
      });
      await prisma.storeIntegration.create({
        data: { storeId: attacker.store.id, provider: "STRIPE", status: "CONNECTED", externalAccountId: "acct_attacker" },
      });

      // A connected merchant can create sessions on their own account with any
      // metadata they like. Stripe stamps event.account with the account the
      // session really lives on, which they cannot forge.
      const response = await postEvent({
        id: "evt_cross_store",
        type: "checkout.session.completed",
        account: "acct_attacker",
        data: {
          object: {
            id: "cs_cross_store",
            amount_total: 9900,
            metadata: { storeId: victim.store.id, productId: victim.product.id },
          },
        },
      });
      check("acknowledged", response.status, 200);

      check("no Order in the victim's store", await prisma.order.count({ where: { storeId: victim.store.id } }), 0);
      // Resolution falls back to the account, so it is the attacker's own
      // store — and the victim's productId does not exist there, so it records
      // an honest "Unknown product" against the account the money is actually in.
      const attackerOrders = await prisma.order.findMany({ where: { storeId: attacker.store.id } });
      check("it lands in the attacker's own store, where the money is", attackerOrders.length, 1);
      check("with no product borrowed from the victim", attackerOrders[0].productName, "Unknown product");
      check("and no dangling product link", attackerOrders[0].productId, null);
    }

    // -----------------------------------------------------------------------
    console.log("\n8. A legitimate payment still succeeds after all of that");
    {
      await server.db.reset();
      const { store, product } = await seedStore("still-works");
      const response = await postEvent(
        completedSession({ sessionId: "cs_final", storeId: store.id, productId: product.id, withShipping: true })
      );
      check("acknowledged", response.status, 200);
      const order = await prisma.order.findFirstOrThrow({ where: { storeId: store.id } });
      check("the Order exists", order.externalOrderId, "cs_final");
      check("for the right product", order.productId, product.id);
      check("and its BusinessEvent", await prisma.businessEvent.count({ where: { storeId: store.id } }), 1);
    }
  } finally {
    await server.close();
  }

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
