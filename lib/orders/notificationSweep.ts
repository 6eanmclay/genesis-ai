import { prismaSystem } from "@/lib/prisma";
import { isEmailConfigured } from "@/lib/email/sendEmail";
import { reportIssue } from "@/lib/observability/reportIssue";
import { enqueueNotification } from "./notificationJobs";
import { ORDER_STATUS } from "@/lib/orders/orderStatus";
import { sendOrderConfirmation, type EmailSender } from "./orderConfirmation";
import { notifyCustomerDelivered } from "./deliveryNotification";
import { notifyCustomerRefunded } from "./refundNotification";

// THE SECOND CHANCE.
//
// ============ WHY A SWEEP AND NOT JUST A RETRY (2026-08-29) ============
//
// Every notification path releases its claim when a send fails, so that
// "something can try again". Until now nothing was that something.
//
// For Stripe it nearly worked: Stripe redelivers a failed webhook, so the next
// delivery re-runs the send. The PayPal path is a BROWSER REDIRECT — the
// customer's own return from PayPal — and nobody redelivers a redirect. A
// transient email failure there meant a paying customer never got a receipt and
// no part of the system knew to try again.
//
// So this sweeps for the fact rather than the event: an order that is paid and
// has no confirmation claim needs one, however it came to be that way. It also
// covers the cases a redelivery cannot — Stripe exhausting its retries, a
// deploy mid-send, and the whole backlog that accumulates while no email is
// configured at all.
//
// ============ WHAT IT DELIBERATELY DOES NOT DO =========================
//
// It does not touch shipmentNotifiedAt. That claim is made inside an execution
// the owner initiated, it already reports to the owner on screen when it fails,
// and sweeping it would mean deciding, unattended, that a label bought
// yesterday should email a customer today — a judgement this has no business
// making.
//
// ============ ownerNotifiedAt WAS ON THAT LIST, AND SHOULD NOT HAVE BEEN
//
// Corrected 2026-09-01. It was excluded alongside shipmentNotifiedAt on the
// same two grounds, and neither of them is true of it:
//
//   "claimed inside an execution the owner initiated" — a sale is initiated by
//   a CUSTOMER. The claim is made inside the Stripe webhook or the PayPal
//   return route, neither of which the owner is present for.
//
//   "already reports to the owner on screen when it fails" — the owner cannot
//   see a failure to tell them something they do not yet know happened. That is
//   the entire condition being notified about.
//
// The consequence was real: notifyOwnerOfSale was called inline and nothing
// enqueued `ownerSale` or looked for a null claim, so a process that died
// between recording an order and sending the email lost the merchant's
// notification permanently. The three CUSTOMER notifications all had the retry
// this one lacked, and the merchant is the person who has work to do.
//
// ============ AND IT RUNS ONCE A DAY ===================================
//
// vercel.json has one cron, daily at 06:00, and Vercel's Hobby plan allows no
// more than that. A receipt that arrives up to a day late is bad; a receipt
// that never arrives is worse, and this is the difference between them. If the
// plan ever allows a shorter interval this wants one — the sweep itself is
// interval-agnostic.

// ============ WHY prismaSystem, AND ONLY FOR THE SEARCH ================
//
// The tenant-isolation extension refuses a findMany with no store in its where
// clause, and it is right to: a cross-tenant read is exactly the mistake it
// exists to catch. This sweep genuinely is cross-tenant — it runs from a cron,
// carries no session, and its whole job is "every store's missed notifications"
// — which is the case lib/prisma.ts documents prismaSystem for.
//
// The unguarded client is used ONLY to find candidate ids. Every send that
// follows goes through the ordinary scoped path with a real storeId, so the
// isolation the search stepped around is enforced on every write.
//
// Found by the harness rather than by reading: the first version used `prisma`
// and threw on its first query.

/** A quiet period before a claimless order is treated as missed. */
const GRACE_MS = 10 * 60 * 1000;

/** How many of each kind one run will attempt. Bounded so a backlog cannot */
/** turn a cron into a mail blast, and so one run cannot exhaust a rate limit. */
const BATCH = 50;

/**
 * ============ THESE COUNT WHAT WAS QUEUED, NOT WHAT WAS SENT =========
 *
 * The sweep discovers due notifications and hands each to the durable queue.
 * Whether the email actually went is the job's outcome and the outbound
 * operation's, not the sweep's — and pretending otherwise would report a send
 * that had not happened yet.
 */
export interface SweepResult {
  confirmations: number;
  deliveries: number;
  refunds: number;
  /**
   * Merchant new-sale notices queued.
   *
   * Counted separately from the three above, not folded into a total: those
   * are transactional emails to a CUSTOMER about their money, and this is a
   * working notice to the MERCHANT about their shop. They fail for different
   * reasons, they matter to different people, and a single number would hide
   * the case that matters most — customers all told, merchant told nothing.
   */
  ownerSales: number;
  /** True when nothing was attempted because email is not configured. */
  skipped: boolean;
}

/**
 * Send what should have been sent and was not.
 *
 * Never throws. It is one stage of a cron that runs several, and the whole
 * point of that route's design is that one failing stage does not take the
 * others down.
 */
export async function runDueOrderNotifications(
  now: Date = new Date(),
  // INJECTABLE FOR THE SAME REASON EVERY NOTIFICATION IS. Without it the only
  // way to prove the sweep sends anything is to let it reach Resend, which is
  // the dependency Phase 1 was explicitly built not to wait for. Production
  // passes nothing and the real sender is used.
  send?: EmailSender,
): Promise<SweepResult> {
  const empty: SweepResult = { confirmations: 0, deliveries: 0, refunds: 0, ownerSales: 0, skipped: false };

  // CHECKED ONCE, HERE. Every individual notification checks too and would
  // report its own line — on a platform with no email configured that is one
  // report per unsent order per day, which is how a real signal gets buried.
  if (!isEmailConfigured()) {
    return { ...empty, skipped: true };
  }

  const before = new Date(now.getTime() - GRACE_MS);
  const result = { ...empty };

  // ============ PAID, AND NEVER CONFIRMED ============================
  //
  // Deliberately not filtered by payment provider. The PayPal redirect is the
  // path with no redelivery, but an order is an order and the fact this reads
  // — "paid, no confirmation claim, old enough" — is true regardless of how it
  // got that way.
  const unconfirmed = await prismaSystem.order.findMany({
    // ============ THE PHANTOM STATUS IS GONE (2026-08-30) ============
    //
    // This read `status: { in: ["paid", "fulfilled"] }` and NOTHING has ever
    // written "fulfilled" to Order.status — fulfilment is its own column and
    // always was. Harmless, and evidence that a vocabulary nobody owns does not
    // stay true; found while adding the dispute states. The vocabulary now
    // lives in lib/orders/orderStatus.ts.
    //
    // A DISPUTED ORDER IS DELIBERATELY EXCLUDED. This sweep sends a
    // confirmation nobody ever sent, and a customer who has just charged the
    // payment back should not receive their first "thanks for your order" — the
    // money is with their bank. If the dispute is won the status returns to
    // paid and the sweep picks it up again, which is the behaviour a derived
    // filter gives for free.
    where: { confirmationSentAt: null, status: ORDER_STATUS.PAID, createdAt: { lt: before } },
    select: { id: true, storeId: true },
    orderBy: { createdAt: "asc" },
    take: BATCH,
  });
  for (const order of unconfirmed) {
    // ENQUEUED, NOT SENT. The sweep is the backstop for a notification
    // the inline path never made; sending here meant a failure waited a
    // full day for the next tick, because nothing else retried.
    if (await enqueueNotification({ orderId: order.id, storeId: order.storeId, kind: "confirmation" })) {
      result.confirmations++;
    }
  }

  // ============ DELIVERED, AND NEVER TOLD ============================
  //
  // No grace period on deliveredAt: unlike a confirmation there is no racing
  // in-request send to wait for — the only writer is applyShipmentUpdate, which
  // notifies inline, so anything still unclaimed here already failed once.
  const undelivered = await prismaSystem.order.findMany({
    where: { deliveredAt: { not: null }, deliveryNotifiedAt: null },
    select: { id: true, storeId: true },
    orderBy: { deliveredAt: "asc" },
    take: BATCH,
  });
  for (const order of undelivered) {
    // ENQUEUED, NOT SENT. The sweep is the backstop for a notification
    // the inline path never made; sending here meant a failure waited a
    // full day for the next tick, because nothing else retried.
    if (await enqueueNotification({ orderId: order.id, storeId: order.storeId, kind: "delivery" })) {
      result.deliveries++;
    }
  }

  // ============ REFUNDED, AND NEVER TOLD =============================
  const unrefunded = await prismaSystem.order.findMany({
    where: { status: "refunded", refundNotifiedAt: null },
    select: { id: true, storeId: true },
    orderBy: { createdAt: "asc" },
    take: BATCH,
  });
  for (const order of unrefunded) {
    // ENQUEUED, NOT SENT. The sweep is the backstop for a notification
    // the inline path never made; sending here meant a failure waited a
    // full day for the next tick, because nothing else retried.
    if (await enqueueNotification({ orderId: order.id, storeId: order.storeId, kind: "refund" })) {
      result.refunds++;
    }
  }

  // ============ SOLD, AND THE MERCHANT NEVER TOLD ====================
  //
  // Added 2026-09-01, and it is a different KIND of notification from the
  // three above rather than a fourth of the same thing. Those tell a CUSTOMER
  // what happened to their money. This tells the MERCHANT that they have work
  // to do, and it is the one notification whose absence means an order sits
  // unshipped while nobody knows it exists.
  //
  // notifyOwnerOfSale has existed since 2026-08-22, with its own claim column,
  // its own runOnce key and correct idempotency. What it never had was a
  // backstop: it was called inline from the Stripe handler and the PayPal
  // return route, and nothing anywhere enqueued `ownerSale` or looked for
  // orders with `ownerNotifiedAt` still null. A process that died between
  // recording the order and sending the email lost the merchant's notification
  // permanently, and the three CUSTOMER notifications all had the retry this
  // one lacked.
  //
  // Same GRACE_MS as the confirmation sweep, and for the same reason: the
  // inline path is given time to do its job before the backstop assumes it
  // did not.
  const unannounced = await prismaSystem.order.findMany({
    // PAID only. An order whose money is disputed or refunded is not a sale to
    // celebrate at somebody, and if a dispute is won the status returns to paid
    // and this picks it up — the same derived-filter behaviour the confirmation
    // sweep relies on rather than a status list of its own.
    where: { ownerNotifiedAt: null, status: ORDER_STATUS.PAID, createdAt: { lt: before } },
    select: { id: true, storeId: true },
    orderBy: { createdAt: "asc" },
    take: BATCH,
  });
  for (const order of unannounced) {
    if (await enqueueNotification({ orderId: order.id, storeId: order.storeId, kind: "ownerSale" })) {
      result.ownerSales++;
    }
  }

  return result;
}
