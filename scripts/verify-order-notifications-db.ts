import { randomUUID } from "crypto";
import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { notifyCustomerDelivered } from "@/lib/orders/deliveryNotification";
import { notifyCustomerRefunded } from "@/lib/orders/refundNotification";
import { runDueOrderNotifications } from "@/lib/orders/notificationSweep";
import { drain } from "@/lib/jobs/queue";
import { makeNotificationHandler } from "@/lib/orders/notificationJobs";

// THE CLAIMS, AGAINST A REAL DATABASE:
//
//   part of the database sweep — npx tsx scripts/run-db-suites.ts
//
// ============ WHAT ONLY A REAL DATABASE CAN SHOW =======================
//
// The pure half (payloads, the sender, the sweep's own shape) is in
// verify-order-notifications.ts and needs nothing. What needs Postgres is the
// part that is actually about concurrency and scoping:
//
//   - a claim won once, and refused the second time
//   - a failed send giving the claim BACK, so a retry is possible
//   - two stores' orders never reachable from each other
//   - the sweep finding exactly what was missed and nothing else
//
// The sender is injected throughout. Nothing here sends anything, and the
// suite runs with no Resend account — which is the entire point of Phase 1.

let failures = 0;
let passes = 0;

function assert(name: string, ok: boolean, detail = ""): void {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  assert(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function main(): Promise<void> {
  // EMAIL MUST LOOK CONFIGURED, or every claim refuses before it starts. The
  // values are never used: every call injects its own sender.
  process.env.RESEND_API_KEY = "harness-not-a-real-key";
  process.env.EMAIL_FROM_ADDRESS = "orders@harness.test";

  await requireTestDatabase(prismaSystem);

  {
    const stamp = Date.now();
    const user = await prisma.user.create({
      data: { email: `notify-${stamp}@example.test`, name: "Owner" },
    });
    const store = await prisma.store.create({
      data: { userId: user.id, name: "Cubit & Coil", slug: `notify-${stamp}`, tagline: "t", description: "d" },
    });
    const other = await prisma.store.create({
      data: { userId: user.id, name: "Other Shop", slug: `other-${stamp}`, tagline: "t", description: "d" },
    });

    async function makeOrder(overrides: Record<string, unknown> = {}, storeId = store.id) {
      return prisma.order.create({
        data: {
          storeId,
          productName: "Copper Tensor Ring",
          amountInCents: 7700,
          buyerEmail: "sarah@example.test",
          paymentProvider: "STRIPE",
          externalOrderId: `cs_${randomUUID()}`,
          status: "paid",
          ...overrides,
        },
      });
    }

    // ==================================================================
    console.log("\n=== 1. A claim is won once ===\n");
    // ==================================================================

    const delivered = await makeOrder({ deliveredAt: new Date() });
    const sent: string[] = [];
    const record = async (input: { to: string }) => {
      sent.push(input.to);
    };

    const first = await notifyCustomerDelivered({ orderId: delivered.id, storeId: store.id }, record);
    eq("the first delivery notice sends", first, { sent: true });
    eq("and the customer was written to once", sent.length, 1);

    const second = await notifyCustomerDelivered({ orderId: delivered.id, storeId: store.id }, record);
    eq("the second is refused as already sent", second, { sent: false, reason: "already_sent" });
    eq("and nothing else was written", sent.length, 1);

    // ============ CONCURRENTLY, WHICH IS THE REAL CASE ==============
    //
    // Two webhook deliveries of the same event arriving at once. A
    // check-then-send would let both pass the check; a conditional update
    // cannot be won twice.
    const raced = await makeOrder({ deliveredAt: new Date() });
    const racedSends: string[] = [];
    const slow = async (input: { to: string }) => {
      await new Promise((r) => setTimeout(r, 15));
      racedSends.push(input.to);
    };
    const both = await Promise.all([
      notifyCustomerDelivered({ orderId: raced.id, storeId: store.id }, slow),
      notifyCustomerDelivered({ orderId: raced.id, storeId: store.id }, slow),
    ]);
    eq("exactly one of two concurrent attempts sends",
      both.filter((r) => r.sent).length, 1);
    eq("and the customer is emailed once", racedSends.length, 1);

    // ==================================================================
    console.log("\n=== 2. A failed send gives the claim back ===\n");
    // ==================================================================
    //
    // Without this a transient failure would mark the order notified forever
    // and no retry — not the webhook's, not the sweep's — could ever fix it.

    const failing = await makeOrder({ deliveredAt: new Date() });
    const boom = async () => {
      throw new Error("resend is down");
    };
    const failed = await notifyCustomerDelivered({ orderId: failing.id, storeId: store.id }, boom);
    assert("a failed send reports why",
      !failed.sent && failed.reason === "send_failed", JSON.stringify(failed));

    const released = await prisma.order.findUniqueOrThrow({
      where: { id: failing.id },
      select: { deliveryNotifiedAt: true },
    });
    eq("and the claim is released", released.deliveryNotifiedAt, null);

    const retried = await notifyCustomerDelivered({ orderId: failing.id, storeId: store.id }, record);
    eq("so a retry succeeds", retried, { sent: true });

    // ==================================================================
    console.log("\n=== 3. One store cannot notify another's customer ===\n");
    // ==================================================================

    const theirs = await makeOrder({ deliveredAt: new Date() }, other.id);
    const crossed = await notifyCustomerDelivered({ orderId: theirs.id, storeId: store.id }, record);
    eq("an order from another store is not found", crossed, { sent: false, reason: "not_found" });
    const untouched = await prisma.order.findUniqueOrThrow({
      where: { id: theirs.id },
      select: { deliveryNotifiedAt: true },
    });
    eq("and its claim is untouched", untouched.deliveryNotifiedAt, null);

    // ==================================================================
    console.log("\n=== 4. Nothing announces something that did not happen ===\n");
    // ==================================================================

    const notDelivered = await makeOrder();
    const premature = await notifyCustomerDelivered({ orderId: notDelivered.id, storeId: store.id }, record);
    assert("an undelivered order is not told it arrived",
      !premature.sent, JSON.stringify(premature));
    const stillNull = await prisma.order.findUniqueOrThrow({
      where: { id: notDelivered.id },
      select: { deliveryNotifiedAt: true },
    });
    eq("and the claim it took is given back", stillNull.deliveryNotifiedAt, null);

    const notRefunded = await makeOrder();
    const noRefund = await notifyCustomerRefunded({ orderId: notRefunded.id, storeId: store.id }, record);
    assert("an unrefunded order is not told it was refunded",
      !noRefund.sent, JSON.stringify(noRefund));

    // ==================================================================
    console.log("\n=== 5. The sweep sends what was missed, and only that ===\n");
    // ==================================================================
    //
    // The PayPal path is a browser redirect nobody redelivers. This is the
    // mechanism that makes a missed receipt recoverable.

    const longAgo = new Date(Date.now() - 60 * 60 * 1000);
    const missed = await makeOrder({ createdAt: longAgo });
    const justNow = await makeOrder();
    const refunded = await makeOrder({ status: "refunded", createdAt: longAgo });
    const alreadyDone = await makeOrder({ createdAt: longAgo, confirmationSentAt: new Date() });

    const before = await prisma.order.count({ where: { storeId: store.id, confirmationSentAt: null } });
    const result = await runDueOrderNotifications(new Date(), record);

    // ============ THE SWEEP NOW QUEUES, IT DOES NOT SEND ============
    //
    // Item 4 moved the backstop onto the durable queue: sending inline meant a
    // failure waited a full day for the next tick, because nothing else
    // retried. The counts are what was ENQUEUED.
    //
    // So the test drains, which exercises more than it used to — discovery,
    // the queue, the handler, and runOnce's exactly-once — rather than one
    // function call.
    assert("the sweep queued the order nobody redelivered",
      result.confirmations >= 1, JSON.stringify(result));
    assert("and queued the refunded customer",
      result.refunds >= 1, JSON.stringify(result));

    // The suite's own handler, carrying the recording sender — a job payload
    // is JSON and cannot carry a function, and drain() takes its handlers as an
    // argument precisely so this is possible without a production seam.
    await drain({ "notification.order": makeNotificationHandler(record) }, { maxJobs: 50 });

    const missedNow = await prisma.order.findUniqueOrThrow({
      where: { id: missed.id },
      select: { confirmationSentAt: true },
    });
    assert("the missed order now has its claim", missedNow.confirmationSentAt !== null, "");

    // ============ AND IT LEAVES ALONE WHAT IT SHOULD ===============
    //
    // An order created moments ago may still have an in-flight send. Sweeping
    // it would race the request that is already doing it.
    const fresh = await prisma.order.findUniqueOrThrow({
      where: { id: justNow.id },
      select: { confirmationSentAt: true },
    });
    eq("an order still inside the grace period is left alone", fresh.confirmationSentAt, null);

    const done = await prisma.order.findUniqueOrThrow({
      where: { id: alreadyDone.id },
      select: { confirmationSentAt: true },
    });
    assert("and one already confirmed is not confirmed twice",
      done.confirmationSentAt !== null, "");

    const refundedNow = await prisma.order.findUniqueOrThrow({
      where: { id: refunded.id },
      select: { refundNotifiedAt: true },
    });
    assert("the refunded order was told", refundedNow.refundNotifiedAt !== null, "");

    assert("the sweep actually had work to find", before > 0, String(before));

    // ============ AND IT STOPS WHEN EMAIL IS NOT CONFIGURED =========
    //
    // Not one report per unsent order per day. One decision, once.
    delete process.env.RESEND_API_KEY;
    const skipped = await runDueOrderNotifications(new Date(), record);
    eq("with no email configured the sweep skips rather than churns",
      // ownerSales joined this shape on 2026-09-01, when the merchant's own
      // new-sale notice gained the backstop the three customer notices had.
      skipped, { confirmations: 0, deliveries: 0, refunds: 0, ownerSales: 0, skipped: true });
    process.env.RESEND_API_KEY = "harness-not-a-real-key";
  }

  console.log(failures === 0 ? `\nAll ${passes} checks passed.` : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
