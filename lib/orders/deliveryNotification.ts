import { prisma } from "@/lib/prisma";
import { formatMoney } from "@/lib/money";
import { claimAndSend, type NotificationOutcome } from "./notificationClaim";
import type { EmailSender } from "./orderConfirmation";

// "IT ARRIVED."
//
// ============ THE END OF THE STORY NOBODY WAS TOLD (2026-08-29) =========
//
// Delivery has been ingested end to end since the carriage milestone:
// applyShipmentUpdate writes deliveredAt, the owner sees it on the order, and
// the lifecycle treats it as terminal. The customer — the only person actually
// waiting for the parcel — was never told anything.
//
// It is the cheapest email in the set and the one most likely to prevent a
// "where is my order?" message, because it arrives at the moment the answer
// changed.
//
// ============ AND IT IS NOT A TRACKING LINK ============================
//
// The shipped email already gave them the tracking number. Repeating it here
// would be the same message twice; what is new is that the wait is over, so the
// email says that and offers a way to raise a problem instead.

export function buildDeliveredEmail(input: {
  order: { buyerEmail: string; productName: string; amountInCents: number; externalOrderId: string };
  store: { name: string; currency: string };
}): { to: string; subject: string; html: string; fromName: string } {
  const { order, store } = input;
  return {
    to: order.buyerEmail,
    // The store's name is in the subject AND now on the sender, so a customer
    // scanning an inbox recognises it before opening anything.
    subject: `Delivered — your order from ${store.name}`,
    fromName: store.name,
    html: [
      `<p>Your order has been delivered.</p>`,
      `<p><strong>${order.productName}</strong> — ${formatMoney(order.amountInCents, store.currency)}</p>`,
      `<p>Order reference: ${order.externalOrderId}</p>`,
      // NOT A SUPPORT PROMISE. It names the business rather than inventing a
      // help desk Genesis does not run, and there is no link because no
      // customer-facing order page exists to link to yet.
      `<p>If something isn't right, reply to this email and ${store.name} will hear from you.</p>`,
    ].join("\n"),
  };
}

/**
 * Tell the customer their order arrived — once.
 *
 * Called after `deliveredAt` has been written, so a delivery that failed to
 * record can never be announced. Never throws: a carrier webhook must not fail
 * because an email did.
 */
export async function notifyCustomerDelivered(
  target: { orderId: string; storeId: string },
  send?: EmailSender,
): Promise<NotificationOutcome> {
  return claimAndSend({
    orderId: target.orderId,
    storeId: target.storeId,
    claim: "deliveryNotifiedAt",
    label: "the delivered notification",
    send,
    load: async () => {
      const order = await prisma.order.findFirst({
        where: { id: target.orderId, storeId: target.storeId },
        select: {
          buyerEmail: true,
          productName: true,
          amountInCents: true,
          externalOrderId: true,
          // THE CLAIM IS NOT THE FACT. An order can be claimed for this
          // notification and turn out not to be delivered — the sweep reads a
          // filter, and a filter is not a guarantee about the row it returns.
          deliveredAt: true,
          store: { select: { name: true, currency: true } },
        },
      });
      if (!order || !order.deliveredAt) return null;
      return order;
    },
    build: (order) => buildDeliveredEmail({ order, store: order.store }),
  });
}
