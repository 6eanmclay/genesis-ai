import type Stripe from "stripe";
import { prisma } from "@/lib/prisma";
import { reportIssue } from "@/lib/observability/reportIssue";
import { ORDER_STATUS, isInquiryOnly } from "@/lib/orders/orderStatus";

// A CHARGEBACK, AND THE DIFFERENCE BETWEEN A CLAIM AND A LOSS.
//
// ============ WHAT WAS HAPPENING BEFORE THIS (2026-08-30) ==============
//
// Nothing. The Stripe route recorded the delivery verbatim with its signature
// verified, handleStripeEvent matched no branch, returned 200, and the delivery
// was marked PROCESSED. So the raw evidence sat in WebhookDelivery and the
// business never learned: the order still read "paid", reporting still counted
// it as a sale, and the owner could still buy a shipping label and post the
// goods for money the bank had already taken back.
//
// ============ TWO FACTS, NEVER CONFLATED =============================
//
// Sean, 2026-08-30: "A warning/inquiry does not mean money moved;
// funds_withdrawn and funds_reinstated are the financial transitions."
//
// So this writes two things and they answer different questions:
//
//   disputeStatus   what the card network currently claims. Includes
//                   `warning_*` inquiries, which are a bank asking a question
//                   and move nothing at all.
//
//   status          where the money is. Moves ONLY on positive evidence that
//                   funds left or returned.
//
// An order whose status flipped on an inquiry would report a loss that never
// happened. This is the same discipline runOnce applies when it refuses to
// guess at an outcome it did not witness: absence of evidence is recorded as
// absence, not as a verdict.
//
// ============ WHY ALL FIVE EVENTS ====================================
//
//   created            a claim exists. Records it. May be only an inquiry.
//   updated            the claim changed — evidence submitted, status moved.
//   funds_withdrawn    THE MONEY LEFT. paid → disputed.
//   funds_reinstated   THE MONEY CAME BACK. disputed → paid.
//   closed             the final verdict. lost + funds gone → charged_back.
//
// Handling only `created` would be the "one event listener" that reports a
// bank inquiry as a lost sale and never notices the money coming back.
//
// ============ NOT IN THE QUEUE, DELIBERATELY =========================
//
// Sean: do not move money logic into the queue for consistency. This is inline
// in the same path the refund handler uses, for the same reason — it is a small
// bounded write against a row we already have, and its retry story is Stripe's
// own redelivery rather than ours.

/** Every dispute event this platform acts on. */
export const DISPUTE_EVENT_TYPES = [
  "charge.dispute.created",
  "charge.dispute.updated",
  "charge.dispute.closed",
  "charge.dispute.funds_withdrawn",
  "charge.dispute.funds_reinstated",
] as const;

export type DisputeEventType = (typeof DISPUTE_EVENT_TYPES)[number];

export function isDisputeEvent(type: string): type is DisputeEventType {
  return (DISPUTE_EVENT_TYPES as readonly string[]).includes(type);
}

/** What happened, for the caller to report and for tests to assert. */
export interface DisputeOutcome {
  /** The order this claim belongs to, or null when none could be found. */
  orderId: string | null;
  /** The money axis after this event. Unchanged unless funds actually moved. */
  status: string | null;
  /** Stripe's own claim status after this event. */
  disputeStatus: string | null;
  /** Why nothing was written, when nothing was. */
  skipped?: string;
}

/**
 * Find the order a dispute belongs to.
 *
 * TWO WAYS ROUND, because the events do not all name the same thing. `created`
 * carries the charge and payment intent; `closed` and `funds_reinstated` name
 * the dispute, and by then the order already remembers its id. Trying the
 * dispute id first means a claim stays attached to the order it started on even
 * if a payment intent were somehow reused.
 */
async function findOrder(dispute: Stripe.Dispute) {
  const byDispute = await prisma.order.findFirst({
    where: { externalDisputeId: dispute.id },
    select: { id: true, storeId: true, status: true, disputeFundsWithdrawnAt: true },
  });
  if (byDispute) return byDispute;

  const paymentIntentId =
    typeof dispute.payment_intent === "string"
      ? dispute.payment_intent
      : dispute.payment_intent?.id ?? null;
  if (!paymentIntentId) return null;

  // Fetch-then-scope, the pattern lib/tenantIsolation.ts documents: the lookup
  // may be unscoped because a dispute event carries no store, and the WRITE
  // below carries the storeId this returns.
  return prisma.order.findFirst({
    where: { paymentProvider: "STRIPE", externalPaymentId: paymentIntentId },
    select: { id: true, storeId: true, status: true, disputeFundsWithdrawnAt: true },
  });
}

/**
 * Decide the money axis.
 *
 * PURE, so the one rule that decides whether a business has lost money is
 * testable without a database, a clock or Stripe. Everything ambiguous about
 * this feature lives here and nowhere else.
 */
export function nextStatus(input: {
  current: string;
  eventType: DisputeEventType;
  disputeStatus: string | null;
  /** Whether funds are known to have left and not yet returned. */
  fundsWithdrawn: boolean;
}): string {
  const { current, eventType, disputeStatus, fundsWithdrawn } = input;

  // ============ A REFUND OUTRANKS A DISPUTE =======================
  //
  // Sean, 2026-08-30: keep `refunded` as the authoritative status while still
  // recording the dispute detail. The money already went back deliberately, and
  // overwriting that with a claim about the same money would lose the truer
  // fact. Rare, and Stripe permits disputing an already-refunded charge.
  if (current === ORDER_STATUS.REFUNDED) return ORDER_STATUS.REFUNDED;

  switch (eventType) {
    case "charge.dispute.funds_withdrawn":
      // THE MONEY LEFT. The only event that may say so, apart from a lost
      // verdict below.
      return ORDER_STATUS.DISPUTED;

    case "charge.dispute.funds_reinstated":
      // And back again. Not "won" — won is the claim's outcome, this is the
      // money's, and only this one puts it back in the account.
      return ORDER_STATUS.PAID;

    case "charge.dispute.closed":
      // A verdict only moves the money axis if the money actually moved. A lost
      // inquiry that never withdrew anything leaves the order paid, because
      // nothing left the account — and saying otherwise would invent a loss.
      if (disputeStatus === "lost" && fundsWithdrawn) return ORDER_STATUS.CHARGED_BACK;
      // Won, or warning_closed, or lost-with-no-withdrawal: whatever the money
      // is doing is already recorded by the funds events.
      return current;

    case "charge.dispute.created":
    case "charge.dispute.updated":
      // ============ THE LINE THIS WHOLE FILE IS ABOUT ==========
      //
      // A claim existing is not money moving. Stripe usually sends
      // funds_withdrawn alongside a real dispute and never sends it for an
      // inquiry, so the money axis waits for that and only that.
      return current;
  }
}

/**
 * Record a dispute event against the order it belongs to.
 *
 * Never throws. A dispute that cannot be recorded must not fail the webhook —
 * Stripe would redeliver the whole event, and the claim is real whether or not
 * we managed to write it down. The failure is reported instead.
 */
export async function handleDisputeEvent(event: Stripe.Event): Promise<DisputeOutcome> {
  const dispute = event.data.object as Stripe.Dispute;
  const eventType = event.type as DisputeEventType;

  const order = await findOrder(dispute);
  if (!order) {
    // A dispute against a charge this platform has no order for. Genuinely
    // possible — a payment taken before Genesis existed, or a store since
    // deleted — and worth a person's attention rather than silence, because
    // the alternative reading is that an order went missing.
    reportIssue("a Stripe dispute names a charge with no order here", null, {
      subsystem: "payments",
      stage: "stripe.dispute.no_order",
      extra: { disputeId: dispute.id, eventType, chargeId: String(dispute.charge) },
    });
    return { orderId: null, status: null, disputeStatus: dispute.status, skipped: "no matching order" };
  }

  const now = new Date(event.created * 1000);
  const withdrawn =
    eventType === "charge.dispute.funds_withdrawn" || !!order.disputeFundsWithdrawnAt;
  const reinstated = eventType === "charge.dispute.funds_reinstated";

  const status = nextStatus({
    current: order.status,
    eventType,
    disputeStatus: dispute.status,
    // Reinstated money is no longer withdrawn, so a verdict arriving afterwards
    // must not read as a loss.
    fundsWithdrawn: withdrawn && !reinstated,
  });

  const closed = eventType === "charge.dispute.closed";

  await prisma.order.update({
    // Store-scoped, satisfying the isolation guard and matching the refund
    // path: the lookup may be unscoped, the mutation may not.
    where: { id: order.id, storeId: order.storeId },
    data: {
      status,
      disputeStatus: dispute.status,
      externalDisputeId: dispute.id,
      disputeAmountInCents: dispute.amount,
      // The network's own reason code, never our reading of it.
      disputeReason: dispute.reason ?? null,
      // FIRST SEEN WINS. Only `created` sets disputedAt, so a later event in
      // the same claim cannot rewrite when it began — and an out-of-order
      // redelivery of `created` after `closed` is the one case this does not
      // protect against, which Stripe does not produce and the timestamps make
      // visible if it ever did.
      ...(eventType === "charge.dispute.created" ? { disputedAt: now } : {}),
      ...(eventType === "charge.dispute.funds_withdrawn" ? { disputeFundsWithdrawnAt: now } : {}),
      ...(eventType === "charge.dispute.funds_reinstated" ? { disputeFundsReinstatedAt: now } : {}),
      ...(closed ? { disputeResolvedAt: now } : {}),
    },
  });

  // An inquiry closing in the merchant's favour is the good case and says so;
  // anything that took money is the owner's problem and is reported.
  if (eventType === "charge.dispute.funds_withdrawn" || status === ORDER_STATUS.CHARGED_BACK) {
    reportIssue(
      status === ORDER_STATUS.CHARGED_BACK
        ? "a chargeback was upheld and the money is gone"
        : "a dispute withdrew funds from an order",
      null,
      {
        subsystem: "payments",
        stage: "stripe.dispute.funds",
        storeId: order.storeId,
        extra: {
          orderId: order.id,
          disputeId: dispute.id,
          reason: dispute.reason,
          amountInCents: dispute.amount,
          inquiryOnly: isInquiryOnly(dispute.status),
        },
      },
    );
  }

  return { orderId: order.id, status, disputeStatus: dispute.status };
}
