import "dotenv/config";
import Stripe from "stripe";
import { prismaSystem } from "../lib/prisma";

// Real end-to-end verification (2026-08-09) — Sean's own requirement:
// "This is not just about having a Stripe connection button. I want the
// real end-to-end transaction verified." No live browser checkout exists
// in this environment, but the webhook handler itself — real signature
// verification, real connected-account trust-boundary resolution, real
// idempotent Order creation, and the newly-added real refund handling —
// can be exercised directly and honestly: this script builds genuine
// Stripe Event payloads, signs them with the REAL local STRIPE_WEBHOOK_SECRET
// using Stripe's own test-signature helper (not a hand-rolled fake), and
// POSTs them over real HTTP to a real running `next dev` server — the
// route's own use of next/server's after() requires a genuine request
// scope, which only a real server (not a direct function import) provides.
// This does NOT verify a real Checkout Session was actually created/paid
// in Stripe (that needs a live browser + a real connected test account) —
// that gap is named honestly, not papered over.
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!;
const BASE_URL = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";

async function postWebhook(payload: unknown): Promise<Response> {
  const body = JSON.stringify(payload);
  const header = stripe.webhooks.generateTestHeaderString({ payload: body, secret: webhookSecret });
  return fetch(`${BASE_URL}/api/webhooks/stripe`, {
    method: "POST",
    headers: { "stripe-signature": header, "content-type": "application/json" },
    body,
  });
}

async function main() {
  const owner = await prismaSystem.user.findFirst({ select: { id: true } });
  if (!owner) throw new Error("No real user found to own the throwaway test store");

  const fakeAccountId = `acct_verify_${Date.now()}`;
  const store = await prismaSystem.store.create({
    data: {
      userId: owner.id,
      name: "Verify Stripe Webhook Store",
      slug: `verify-stripe-webhook-${Date.now()}`,
    },
  });
  const product = await prismaSystem.product.create({
    data: { storeId: store.id, name: "Verify Test Product", priceInCents: 2500 },
  });
  await prismaSystem.storeIntegration.create({
    data: {
      storeId: store.id,
      provider: "STRIPE",
      status: "CONNECTED",
      externalAccountId: fakeAccountId,
    },
  });

  try {
    const sessionId = `cs_test_verify_${Date.now()}`;
    const paymentIntentId = `pi_verify_${Date.now()}`;

    const checkoutCompletedEvent = {
      id: `evt_verify_${Date.now()}`,
      object: "event",
      type: "checkout.session.completed",
      account: fakeAccountId, // connected-account event — exercises the real trust-boundary resolution path
      data: {
        object: {
          id: sessionId,
          object: "checkout.session",
          amount_total: 2500,
          payment_intent: paymentIntentId,
          customer_details: { email: "verify-buyer@test.example" },
          metadata: { storeId: store.id, productId: product.id },
          collected_information: null,
        },
      },
    };

    // Case 1: a genuine signed webhook creates a real Order.
    const res1 = await postWebhook(checkoutCompletedEvent);
    if (res1.status !== 200) throw new Error(`Case 1 FAILED: expected 200, got ${res1.status}`);
    const order = await prismaSystem.order.findUnique({
      where: { paymentProvider_externalOrderId: { paymentProvider: "STRIPE", externalOrderId: sessionId } },
    });
    if (!order) throw new Error("Case 1 FAILED: webhook did not create an Order");
    if (order.status !== "paid" || order.amountInCents !== 2500 || order.externalPaymentId !== paymentIntentId) {
      throw new Error(`Case 1 FAILED: Order fields wrong: ${JSON.stringify(order)}`);
    }
    console.log("Case 1 (signed webhook resolves connected-account trust boundary + creates a real, correct Order): PASS");

    // Case 2: Stripe redelivering the SAME event must not create a duplicate.
    const res2 = await postWebhook(checkoutCompletedEvent);
    if (res2.status !== 200) throw new Error(`Case 2 FAILED: expected 200 on redelivery, got ${res2.status}`);
    const allOrders = await prismaSystem.order.findMany({ where: { storeId: store.id } });
    if (allOrders.length !== 1) throw new Error(`Case 2 FAILED: expected exactly 1 Order after redelivery, got ${allOrders.length}`);
    console.log("Case 2 (redelivered webhook is a genuine idempotent no-op, no duplicate Order): PASS");

    // Case 3: an invalid signature is rejected — never trust an unsigned/forged event.
    const res3 = await fetch(`${BASE_URL}/api/webhooks/stripe`, {
      method: "POST",
      headers: { "stripe-signature": "t=1,v1=deadbeef", "content-type": "application/json" },
      body: JSON.stringify(checkoutCompletedEvent),
    });
    if (res3.status !== 400) throw new Error(`Case 3 FAILED: expected 400 for a forged signature, got ${res3.status}`);
    console.log("Case 3 (forged/invalid signature is rejected with 400): PASS");

    // Case 4: a real charge.refunded event flips the Order to "refunded".
    const refundEvent = {
      id: `evt_verify_refund_${Date.now()}`,
      object: "event",
      type: "charge.refunded",
      account: fakeAccountId,
      data: {
        object: {
          id: `ch_verify_${Date.now()}`,
          object: "charge",
          payment_intent: paymentIntentId,
          amount: 2500,
          amount_refunded: 2500,
        },
      },
    };
    const res4 = await postWebhook(refundEvent);
    if (res4.status !== 200) throw new Error(`Case 4 FAILED: expected 200, got ${res4.status}`);
    const refundedOrder = await prismaSystem.order.findUnique({ where: { id: order.id } });
    if (refundedOrder?.status !== "refunded") {
      throw new Error(`Case 4 FAILED: expected status "refunded", got "${refundedOrder?.status}"`);
    }
    console.log("Case 4 (real charge.refunded event correctly flips Order.status to refunded): PASS");

    // Case 5: a PARTIAL refund on a fresh order must NOT flip status — named limitation, verified as intentional.
    const sessionId2 = `cs_test_verify_partial_${Date.now()}`;
    const paymentIntentId2 = `pi_verify_partial_${Date.now()}`;
    await postWebhook({
      ...checkoutCompletedEvent,
      id: `evt_verify_2_${Date.now()}`,
      data: { object: { ...checkoutCompletedEvent.data.object, id: sessionId2, payment_intent: paymentIntentId2 } },
    });
    await postWebhook({
      id: `evt_verify_partial_refund_${Date.now()}`,
      object: "event",
      type: "charge.refunded",
      account: fakeAccountId,
      data: { object: { id: `ch_verify_partial_${Date.now()}`, object: "charge", payment_intent: paymentIntentId2, amount: 2500, amount_refunded: 500 } },
    });
    const partiallyRefundedOrder = await prismaSystem.order.findUnique({
      where: { paymentProvider_externalOrderId: { paymentProvider: "STRIPE", externalOrderId: sessionId2 } },
    });
    if (partiallyRefundedOrder?.status !== "paid") {
      throw new Error(`Case 5 FAILED: a partial refund should not change status, got "${partiallyRefundedOrder?.status}"`);
    }
    console.log("Case 5 (partial refund correctly does NOT flip status — named limitation, not a bug): PASS");

    console.log("\nAll Stripe webhook end-to-end assertions passed.");
    console.log("NOT verified by this script: a real live Checkout Session created via a real browser against a real connected test account — that needs Sean's own live test purchase.");
  } finally {
    await prismaSystem.order.deleteMany({ where: { storeId: store.id } });
    await prismaSystem.storeIntegration.deleteMany({ where: { storeId: store.id } });
    await prismaSystem.product.deleteMany({ where: { storeId: store.id } });
    await prismaSystem.store.delete({ where: { id: store.id } });
  }
}

main()
  .catch((err) => {
    console.error("FAILED:", err);
    process.exitCode = 1;
  })
  .finally(() => prismaSystem.$disconnect());
