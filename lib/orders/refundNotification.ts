import { prisma } from "@/lib/prisma";
import { formatMoney } from "@/lib/money";
import { claimAndSend, type NotificationOutcome } from "./notificationClaim";
import type { EmailSender } from "./orderConfirmation";

// "YOU HAVE BEEN REFUNDED."
//
// ============ THE MONEY MOVED AND NOBODY SAID SO (2026-08-29) ==========
//
// A full refund flips Order.status to "refunded" from the charge.refunded
// webhook, the owner sees it, and the customer finds out whenever their bank
// gets round to it. An email that says "this was refunded, here is what for" is
// the difference between a resolved problem and a chargeback.
//
// ============ IT DELIBERATELY PROMISES NO TIMING =======================
//
// How long a refund takes to appear is decided by the customer's bank, not by
// Genesis and not by Stripe. "Five to ten business days" is the number every
// other shop prints and it is a guess. This says it has been sent and where it
// is going, which are both facts we hold.
//
// ONLY FULL REFUNDS REACH HERE, because only a full refund flips the status.
// Partial refunds are a named gap in the webhook's own comment — Order.status
// does not model them at all — and inventing a partial-refund email would be
// claiming an amount the schema cannot tell us.

export function buildRefundEmail(input: {
  order: { buyerEmail: string; productName: string; amountInCents: number; externalOrderId: string };
  store: { name: string; currency: string };
}): { to: string; subject: string; html: string; fromName: string } {
  const { order, store } = input;
  return {
    to: order.buyerEmail,
    subject: `Refunded — your order from ${store.name}`,
    fromName: store.name,
    html: [
      `<p>${store.name} has refunded your order in full.</p>`,
      `<p><strong>${order.productName}</strong> — ${formatMoney(order.amountInCents, store.currency)}</p>`,
      `<p>Order reference: ${order.externalOrderId}</p>`,
      // NO INVENTED TIMELINE. See the note above.
      `<p>The refund has been sent back to the card you paid with. How long it takes to appear is up to your bank.</p>`,
    ].join("\n"),
  };
}

/**
 * Tell the customer their order was refunded — once.
 *
 * Called after the status has been written, so a refund that failed to record
 * can never be announced. Never throws: a Stripe webhook must not fail because
 * an email did — Stripe would retry the whole event and the refund is already
 * applied.
 */
export async function notifyCustomerRefunded(
  target: { orderId: string; storeId: string },
  send?: EmailSender,
): Promise<NotificationOutcome> {
  return claimAndSend({
    orderId: target.orderId,
    storeId: target.storeId,
    claim: "refundNotifiedAt",
    label: "the refund notification",
    send,
    load: async () => {
      const order = await prisma.order.findFirst({
        where: { id: target.orderId, storeId: target.storeId },
        select: {
          buyerEmail: true,
          productName: true,
          amountInCents: true,
          externalOrderId: true,
          // Re-read rather than trusted from the caller: an order that is not
          // actually refunded must never be told it was.
          status: true,
          store: { select: { name: true, currency: true } },
        },
      });
      if (!order || order.status !== "refunded") return null;
      return order;
    },
    build: (order) => buildRefundEmail({ order, store: order.store }),
  });
}
