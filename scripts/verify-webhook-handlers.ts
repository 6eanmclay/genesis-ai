import Stripe from "stripe";
import { startTestDatabase } from "@/scripts/lib/testDatabase";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";

// The webhook route handlers themselves, attacked. Brings its own database:
//
//   npx tsx scripts/verify-webhook-handlers.ts
//
// verify-webhook-store.ts asserts the store-resolution DECISION. This calls the
// actual POST handlers with real signed payloads and asserts what lands in the
// database — forged signatures, replays, duplicates, mismatched ids.
//
// SCOPE, stated because it is a real limit rather than an omission. The
// merchant webhook's order-creation branch ends with Next's `after()`, which
// throws outside a request scope, so that one path needs a running server and
// is covered by verify-stripe-webhook-e2e.ts instead. Everything that returns
// BEFORE it is here — including signature verification, which is the actual
// security boundary — and the platform billing webhook is covered end to end,
// because it never calls after() at all.

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

const PLATFORM_SECRET = "whsec_platform_test_secret";
const MERCHANT_SECRET = "whsec_merchant_test_secret";

async function main() {
  const db = await startTestDatabase();
  await db.prisma.$disconnect();

  // Everything the routes read at import time.
  process.env[TEST_DATABASE_ENV] = "1";
  process.env.DATABASE_URL = db.url;
  process.env.STRIPE_SECRET_KEY = "sk_test_not_a_real_key";
  process.env.STRIPE_WEBHOOK_SECRET = MERCHANT_SECRET;
  process.env.STRIPE_PLATFORM_WEBHOOK_SECRET = PLATFORM_SECRET;

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const { prismaSystem: prisma } = await import("@/lib/prisma");
  const { POST: platformPost } = await import("@/app/api/webhooks/stripe-platform/route");
  const { POST: merchantPost } = await import("@/app/api/webhooks/stripe/route");

  /** A genuinely signed request, exactly as Stripe would send it. */
  function signedRequest(event: unknown, secret: string): Request {
    const payload = JSON.stringify(event);
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret });
    return new Request("https://example.test/webhook", {
      method: "POST",
      headers: { "stripe-signature": header, "content-type": "application/json" },
      body: payload,
    });
  }

  /**
   * PGlite closes the connection on any Postgres-level error, and some of these
   * cases deliberately cause one deep inside a transaction. Forces a fresh
   * connection so the NEXT assertion is testing the code rather than the socket.
   */
  async function heal() {
    for (let attempt = 0; attempt < 3; attempt++) {
      await prisma.$disconnect().catch(() => {});
      try {
        await prisma.$queryRaw`SELECT 1`;
        return;
      } catch {
        // Another fresh connection.
      }
    }
  }

  async function reset() {
    await heal();
    const tables = await prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename <> '_prisma_migrations'
        AND tablename <> '_genesis_test_database'`;
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`
    );
  }

  async function makeStore(slug: string) {
    const user = await prisma.user.create({ data: { email: `${slug}@example.test` } });
    return prisma.store.create({
      data: { userId: user.id, name: slug, slug, tagline: "t", description: "d" },
    });
  }
  const balanceOf = async (id: string) =>
    (await prisma.store.findUniqueOrThrow({ where: { id }, select: { growthPointBalance: true } })).growthPointBalance;

  const pointsEvent = (storeId: string, sessionId: string, pointAmount = "500") => ({
    id: `evt_${sessionId}`,
    type: "checkout.session.completed",
    data: { object: { id: sessionId, mode: "payment", metadata: { storeId, pointAmount } } },
  });

  // -------------------------------------------------------------------------
  console.log("\n1. An unsigned or forged request is refused before anything happens");
  {
    await reset();
    const store = await makeStore("sig");

    // No signature at all.
    const bare = new Request("https://example.test/webhook", {
      method: "POST",
      body: JSON.stringify(pointsEvent(store.id, "cs_nosig")),
    });
    check("a request with no signature is rejected", (await platformPost(bare)).status, 400);

    // A signature computed with the WRONG secret. This is the whole security
    // boundary: without it, anyone who knows the URL can credit themselves
    // unlimited Growth Points.
    const forged = signedRequest(pointsEvent(store.id, "cs_forged"), "whsec_attacker_secret");
    check("a signature from the wrong secret is rejected", (await platformPost(forged)).status, 400);

    // A payload edited after signing.
    const payload = JSON.stringify(pointsEvent(store.id, "cs_tamper"));
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret: PLATFORM_SECRET });
    const tampered = new Request("https://example.test/webhook", {
      method: "POST",
      headers: { "stripe-signature": header },
      body: payload.replace('"500"', '"999999"'),
    });
    check("a payload edited after signing is rejected", (await platformPost(tampered)).status, 400);

    check("and not one point was credited", await balanceOf(store.id), 0);
    check("nor any ledger row written", await prisma.growthPointTransaction.count(), 0);
  }

  // -------------------------------------------------------------------------
  console.log("\n2. A genuine purchase credits once, and a replay does not");
  {
    await reset();
    const store = await makeStore("replay");
    const event = pointsEvent(store.id, "cs_replay_1");

    check("the first delivery is accepted", (await platformPost(signedRequest(event, PLATFORM_SECRET))).status, 200);
    check("points are credited", await balanceOf(store.id), 500);

    // Stripe redelivers on any non-2xx, on timeouts, and sometimes just because.
    await platformPost(signedRequest(event, PLATFORM_SECRET));
    await platformPost(signedRequest(event, PLATFORM_SECRET));
    check("three deliveries of one event credit once", await balanceOf(store.id), 500);
    check("and write one row", await prisma.growthPointTransaction.count({ where: { type: "PURCHASE" } }), 1);

    // A genuinely different purchase must still land, or idempotency has been
    // keyed on the wrong thing and the second sale is silently lost.
    await platformPost(signedRequest(pointsEvent(store.id, "cs_replay_2"), PLATFORM_SECRET));
    check("a different session credits normally", await balanceOf(store.id), 1000);
  }

  // -------------------------------------------------------------------------
  console.log("\n3. Money that cannot be applied leaves a trace");
  {
    await reset();
    const store = await makeStore("unapplied");

    // A real payment whose metadata says nothing usable. Before this audit the
    // handler logged to console and returned 200, so Stripe never retried and
    // the owner never knew someone had paid for nothing.
    const broken = {
      id: "evt_broken",
      type: "checkout.session.completed",
      data: { object: { id: "cs_broken", mode: "payment", metadata: { storeId: store.id, pointAmount: "not-a-number" } } },
    };
    check("Stripe is still acknowledged", (await platformPost(signedRequest(broken, PLATFORM_SECRET))).status, 200);
    check("no points invented", await balanceOf(store.id), 0);

    const failures_ = await prisma.executionLog.findMany({ where: { storeId: store.id, status: "FAILED" } });
    check("a FAILED record exists for the owner to see", failures_.length, 1);
    assert("naming the session", failures_[0].message.includes("cs_broken"), failures_[0].message);
    assert("and telling them to reconcile it", failures_[0].message.toLowerCase().includes("reconcile"));
  }

  // -------------------------------------------------------------------------
  console.log("\n4. A payment naming no store cannot be filed against one");
  {
    await reset();
    const store = await makeStore("victim");
    const orphan = {
      id: "evt_orphan",
      type: "checkout.session.completed",
      data: { object: { id: "cs_orphan", mode: "payment", metadata: { pointAmount: "500" } } },
    };
    check("acknowledged", (await platformPost(signedRequest(orphan, PLATFORM_SECRET))).status, 200);
    // With no storeId there is nothing to attach a record to — and crucially,
    // it must NOT be attached to some other store that happens to exist.
    check("the innocent store gets no points", await balanceOf(store.id), 0);
    check("and no record against it", await prisma.executionLog.count({ where: { storeId: store.id } }), 0);
  }

  // -------------------------------------------------------------------------
  console.log("\n5. A forged storeId cannot credit someone else's store");
  {
    await reset();
    const victim = await makeStore("rich");
    // The platform webhook is platform-key only, so metadata IS ours end to
    // end — but the handler must still only ever credit the store the metadata
    // names, never fall back to "some store".
    const wrong = pointsEvent("store_does_not_exist", "cs_ghost");
    const response = await platformPost(signedRequest(wrong, PLATFORM_SECRET));
    // Before the fix this threw P2025 out of the handler: a 500, which Stripe
    // then retried for days against something that could never succeed, while
    // the payment left no trace anyone would find.
    check("a session naming a non-existent store is acknowledged, not retried forever", response.status, 200);
    await heal();
    check("and the real store is untouched", await balanceOf(victim.id), 0);
  }

  // -------------------------------------------------------------------------
  console.log("\n6. The merchant webhook refuses forged signatures too");
  {
    await reset();
    const store = await makeStore("merchant");
    const orderEvent = {
      id: "evt_order",
      type: "checkout.session.completed",
      data: { object: { id: "cs_order_1", metadata: { storeId: store.id, productId: "prod_x" }, amount_total: 2500 } },
    };

    check("no signature is rejected", (await merchantPost(new Request("https://example.test/w", {
      method: "POST", body: JSON.stringify(orderEvent),
    }))).status, 400);

    check("the wrong secret is rejected",
      (await merchantPost(signedRequest(orderEvent, "whsec_wrong"))).status, 400);

    // The platform secret must not work on the merchant endpoint. They are
    // separate endpoints with independent secrets precisely so a leak of one
    // does not authorise the other.
    check("the PLATFORM secret does not work here",
      (await merchantPost(signedRequest(orderEvent, PLATFORM_SECRET))).status, 400);

    check("and no order was created", await prisma.order.count(), 0);
  }

  // -------------------------------------------------------------------------
  console.log("\n7. A checkout that cannot be resolved records the loss");
  {
    await reset();
    const store = await makeStore("noproduct");
    // Resolvable store, no product — the branch that returns before after().
    const noProduct = {
      id: "evt_noproduct",
      type: "checkout.session.completed",
      data: { object: { id: "cs_noproduct", metadata: { storeId: store.id }, amount_total: 4200 } },
    };
    check("acknowledged", (await merchantPost(signedRequest(noProduct, MERCHANT_SECRET))).status, 200);
    check("no order invented", await prisma.order.count(), 0);

    const recorded = await prisma.executionLog.findMany({ where: { storeId: store.id, status: "FAILED" } });
    check("the owner gets a record", recorded.length, 1);
    assert("naming the session", recorded[0].message.includes("cs_noproduct"), recorded[0].message);
  }


  // -------------------------------------------------------------------------
  console.log("\n8. Refunds move exactly one order, and only on a full refund");
  {
    await reset();
    const store = await makeStore("refunds");
    const order = async (id: string, intent: string | null, amountInCents = 5000) =>
      prisma.order.create({
        data: {
          storeId: store.id, productName: "Candle", amountInCents,
          buyerEmail: "b@example.test", status: "paid",
          paymentProvider: "STRIPE", externalOrderId: id, externalPaymentId: intent,
        },
      });

    const refundEvent = (intent: string, refunded: number, total: number) => ({
      id: `evt_${intent}_${refunded}`,
      type: "charge.refunded",
      data: { object: { payment_intent: intent, amount_refunded: refunded, amount: total } },
    });
    const statusOf = async (externalOrderId: string) =>
      (await prisma.order.findFirstOrThrow({ where: { storeId: store.id, externalOrderId } })).status;

    // A FULL refund is the only thing that flips the order.
    await order("cs_full", "pi_full");
    await merchantPost(signedRequest(refundEvent("pi_full", 5000, 5000), MERCHANT_SECRET));
    check("a full refund marks the order refunded", await statusOf("cs_full"), "refunded");

    // A PARTIAL refund deliberately does not. The owner still has to ship it,
    // and relabelling a substantially-paid order would mislead them about that.
    await order("cs_partial", "pi_partial");
    await merchantPost(signedRequest(refundEvent("pi_partial", 500, 5000), MERCHANT_SECRET));
    check("a partial refund leaves it paid", await statusOf("cs_partial"), "paid");

    // Replay. Stripe redelivers refunds like anything else.
    await merchantPost(signedRequest(refundEvent("pi_full", 5000, 5000), MERCHANT_SECRET));
    await merchantPost(signedRequest(refundEvent("pi_full", 5000, 5000), MERCHANT_SECRET));
    check("replaying a refund is a no-op", await statusOf("cs_full"), "refunded");

    // A refund for a charge this platform has never seen must not crash the
    // endpoint, or Stripe retries it forever.
    const unknown = await merchantPost(signedRequest(refundEvent("pi_never_seen", 100, 100), MERCHANT_SECRET));
    check("an unmatched refund is acknowledged", unknown.status, 200);

    // ONLY the matching order moves. A refund must never sweep a store's other
    // orders along with it.
    check("the partial-refund order is still untouched", await statusOf("cs_partial"), "paid");
    check("and nothing else changed status",
      await prisma.order.count({ where: { storeId: store.id, status: "refunded" } }), 1);
  }

  // -------------------------------------------------------------------------
  console.log("\n9. A connected merchant cannot claim another store's sale");
  {
    await reset();
    const victim = await makeStore("victim-store");
    const attacker = await makeStore("attacker-store");
    await prisma.storeIntegration.create({
      data: { storeId: victim.id, provider: "STRIPE", status: "CONNECTED", externalAccountId: "acct_victim" },
    });
    await prisma.storeIntegration.create({
      data: { storeId: attacker.id, provider: "STRIPE", status: "CONNECTED", externalAccountId: "acct_attacker" },
    });

    // A connected merchant CAN create sessions on their own account with any
    // metadata they like — including a storeId that is not theirs. Stripe
    // stamps event.account with the account the session really lives on.
    const forged = {
      id: "evt_forged_claim",
      type: "checkout.session.completed",
      account: "acct_attacker",
      data: { object: { id: "cs_forged_claim", metadata: { storeId: victim.id }, amount_total: 9900 } },
    };
    check("acknowledged", (await merchantPost(signedRequest(forged, MERCHANT_SECRET))).status, 200);

    // The claim is ignored and the event is filed against the account it really
    // came from. No product, so it records there rather than creating an order.
    check("nothing is recorded against the victim",
      await prisma.executionLog.count({ where: { storeId: victim.id } }), 0);
    check("it is recorded against the attacker's own store",
      await prisma.executionLog.count({ where: { storeId: attacker.id, status: "FAILED" } }), 1);
    check("and no order exists anywhere", await prisma.order.count(), 0);
  }


  // -------------------------------------------------------------------------
  console.log("\n10. A misconfigured endpoint is not mistaken for an attack");
  {
    await reset();
    const store = await makeStore("misconfig");
    const event = pointsEvent(store.id, "cs_misconfig");
    const configured = process.env.STRIPE_PLATFORM_WEBHOOK_SECRET;

    // The defect: with the variable unset, constructEvent throws a TypeError,
    // which the old catch turned into 400 "Invalid signature". 400 tells Stripe
    // the request is permanently bad, so it stops retrying — converting a
    // missing environment variable into real payments that never became orders,
    // logged as something that reads like an attack.
    delete process.env.STRIPE_PLATFORM_WEBHOOK_SECRET;
    const unset = await platformPost(signedRequest(event, PLATFORM_SECRET));
    check("an unset secret answers 500, so Stripe keeps retrying", unset.status, 500);
    assert("and not 400, which would make Stripe give up", unset.status !== 400);

    process.env.STRIPE_PLATFORM_WEBHOOK_SECRET = "   ";
    check("a blank secret is treated the same", (await platformPost(signedRequest(event, PLATFORM_SECRET))).status, 500);

    check("and nothing was credited while misconfigured", await balanceOf(store.id), 0);

    // Restored: a genuinely forged signature must STILL be 400. Answering 500
    // to everything would just move the problem — Stripe would retry forgeries
    // forever.
    process.env.STRIPE_PLATFORM_WEBHOOK_SECRET = configured;
    check("a forged signature is still 400",
      (await platformPost(signedRequest(event, "whsec_attacker"))).status, 400);
    check("and a real one still works",
      (await platformPost(signedRequest(event, PLATFORM_SECRET))).status, 200);
    check("crediting normally once configured", await balanceOf(store.id), 500);
  }

  await prisma.$disconnect();
  await db.close();
  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
