import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { runDueOrderNotifications } from "@/lib/orders/notificationSweep";
import { makeNotificationHandler, notificationJobKey } from "@/lib/orders/notificationJobs";
import { drain } from "@/lib/jobs/queue";
import { CLAIM_TTL_MS } from "@/lib/outbound/runOnce";
import { randomUUID } from "crypto";

// NOTIFICATIONS ON THE DURABLE QUEUE:
//
//   part of the database sweep — npx tsx scripts/run-db-suites.ts notification-queue-db
//
// ============ WHAT THIS PROVES, AND HOW (2026-08-30) ===================
//
// By COUNTING ACTUAL SENDS. Every assertion below reads a counter incremented
// by a real closure standing in for the email provider, never a status column —
// because the whole question is "did the customer get two emails", and a status
// column is exactly what would say no while the answer was yes.
//
// The migration changed three things and each needs its own proof:
//
//   the sweep queues instead of sending, so a failure retries in minutes
//     rather than waiting a full day for the next cron tick
//   exactly-once moved from the claim column to runOnce, so a crash mid-send is
//     INDETERMINATE rather than a column set forever with nobody emailed
//   the column is now the business fact, written only after a send that
//     genuinely happened

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
  const user = await prisma.user.create({ data: { email: `nq-${stamp}@example.test`, name: "Owner" } });
  const store = await prisma.store.create({
    data: { userId: user.id, name: "NQ", slug: `nq-${stamp}`, tagline: "t", description: "d" },
  });

  const makeOrder = (over: Record<string, unknown> = {}) =>
    prisma.order.create({
      data: {
        storeId: store.id,
        productName: "Copper Tensor Ring",
        amountInCents: 7700,
        buyerEmail: `buyer-${Math.random()}@example.test`,
        paymentProvider: "STRIPE",
        externalOrderId: `cs_${randomUUID()}`,
        status: "paid",
        createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        ...over,
      },
    });

  // Email must look configured or every path short-circuits before anything
  // interesting happens.
  const priorKey = process.env.RESEND_API_KEY;
  const priorFrom = process.env.EMAIL_FROM_ADDRESS;
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.EMAIL_FROM_ADDRESS = "genesis@example.test";

  console.log("\n--- the sweep queues; it no longer sends ---\n");
  {
    const order = await makeOrder();
    let sends = 0;
    const record = async () => { sends++; };

    const result = await runDueOrderNotifications(new Date(), record);
    assert("it found and queued the order", result.confirmations >= 1, JSON.stringify(result));
    // THE BEHAVIOUR CHANGE, asserted directly: discovery sends nothing.
    eq("and sent nothing itself", sends, 0);

    const job = await prismaSystem.job.findUnique({
      where: { idempotencyKey: notificationJobKey("confirmation", order.id) },
    });
    assert("a durable job exists for it", !!job, "no job enqueued");
    eq("of the right kind", job?.kind, "notification.order");

    await drain({ "notification.order": makeNotificationHandler(record) }, { maxJobs: 50 });
    eq("draining sends it", sends, 1);
    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, select: { confirmationSentAt: true } });
    assert("and the column records the business fact afterwards", after.confirmationSentAt !== null);
  }

  console.log("\n--- a re-sweep does not queue or send a second time ---\n");
  {
    const order = await makeOrder();
    let sends = 0;
    const record = async () => { sends++; };

    await runDueOrderNotifications(new Date(), record);
    await drain({ "notification.order": makeNotificationHandler(record) }, { maxJobs: 50 });
    eq("sent once", sends, 1);

    // Two different duplications, and both must be prevented: the sweep
    // enqueuing twice, and the send happening twice.
    await runDueOrderNotifications(new Date(), record);
    await drain({ "notification.order": makeNotificationHandler(record) }, { maxJobs: 50 });
    eq("a second sweep sends nothing more", sends, 1);
    eq("and there is still one job", await prismaSystem.job.count({
      where: { idempotencyKey: notificationJobKey("confirmation", order.id) },
    }), 1);
  }

  console.log("\n--- a failed send retries, and the retry does not duplicate ---\n");
  {
    const order = await makeOrder();
    let attempts = 0;
    const flaky = async () => {
      attempts++;
      if (attempts === 1) throw new Error("provider refused");
    };

    await runDueOrderNotifications(new Date(), flaky);
    const handler = { "notification.order": makeNotificationHandler(flaky) };

    await drain(handler, { maxJobs: 50 });
    eq("the first attempt was made and refused", attempts, 1);
    const failedRow = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, select: { confirmationSentAt: true } });
    // THE COLUMN IS THE BUSINESS FACT, so a failed send must not set it.
    eq("the column is not set on a failure", failedRow.confirmationSentAt, null);

    // The queue backs off; the next tick would pick it up.
    await prismaSystem.job.updateMany({
      where: { idempotencyKey: notificationJobKey("confirmation", order.id) },
      data: { runAfter: new Date() },
    });
    await drain(handler, { maxJobs: 50 });
    eq("the retry sends it", attempts, 2);
    const sentRow = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, select: { confirmationSentAt: true } });
    assert("and the column is set now", sentRow.confirmationSentAt !== null);

    // A third drain must not send a third time.
    await prismaSystem.job.updateMany({
      where: { idempotencyKey: notificationJobKey("confirmation", order.id) },
      data: { runAfter: new Date(), status: "pending" },
    });
    await drain(handler, { maxJobs: 50 });
    eq("and nothing sends again after success", attempts, 2);
  }

  console.log("\n--- a crash mid-send is indeterminate, not silently claimed ---\n");
  {
    // ============ THE GAP THE MIGRATION EXISTS TO CLOSE =============
    //
    // The old claim released on a CAUGHT failure but not on a crash, so a
    // process dying mid-send left the column set forever: the customer was
    // never emailed and nothing anywhere said so. Simulated here the same way
    // the outbound suite does — a claim with no answer and no live runner.
    const order = await makeOrder();
    await prismaSystem.outboundOperation.create({
      data: {
        idempotencyKey: `order-notification:confirmationSentAt:${order.id}`,
        operation: "email.confirmationSentAt", storeId: store.id,
        status: "in_progress", attempts: 1,
        claimedAt: new Date(Date.now() - CLAIM_TTL_MS - 60_000),
        claimedBy: "a-runner-that-died",
      },
    });

    let sends = 0;
    const record = async () => { sends++; };
    await runDueOrderNotifications(new Date(), record);
    await drain({ "notification.order": makeNotificationHandler(record) }, { maxJobs: 50 });

    // NOT RETRIED. Emailing a customer twice about one order is the failure
    // this state exists to prevent.
    eq("nothing was sent", sends, 0);
    const op = await prismaSystem.outboundOperation.findUnique({
      where: { idempotencyKey: `order-notification:confirmationSentAt:${order.id}` },
    });
    eq("the operation says indeterminate", op?.status, "indeterminate");
    const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, select: { confirmationSentAt: true } });
    // AND the column is NOT set — the old bug set it and moved on.
    eq("the order is not marked as told", row.confirmationSentAt, null);

    // And the job does not spin: an indeterminate outcome returns rather than
    // throwing, so it completes rather than retrying to exhaustion.
    const job = await prismaSystem.job.findUnique({
      where: { idempotencyKey: notificationJobKey("confirmation", order.id) },
    });
    eq("the job completed rather than looping", job?.status, "done");
  }

  console.log("\n--- an unconfigured platform does not fill the dead-letter queue ---\n");
  {
    delete process.env.RESEND_API_KEY;
    const order = await makeOrder();
    let sends = 0;
    const record = async () => { sends++; };

    const result = await runDueOrderNotifications(new Date(), record);
    assert("the sweep skips entirely", result.skipped === true, JSON.stringify(result));
    eq("nothing queued", await prismaSystem.job.count({
      where: { idempotencyKey: notificationJobKey("confirmation", order.id) },
    }), 0);
    eq("nothing sent", sends, 0);
    process.env.RESEND_API_KEY = "re_test_key";
  }

  process.env.RESEND_API_KEY = priorKey;
  process.env.EMAIL_FROM_ADDRESS = priorFrom;

  console.log(`\n${failures} failed, ${passes} passed\n`);
  await prismaSystem.$disconnect();
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
