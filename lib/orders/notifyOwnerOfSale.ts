import { prisma } from "@/lib/prisma";
import { sendEmail, isEmailConfigured } from "@/lib/email/sendEmail";
import { reportIssue } from "@/lib/observability/reportIssue";
import { formatMoney } from "@/lib/money";
import type { EmailSender } from "./orderConfirmation";
import { runOnce } from "@/lib/outbound/runOnce";
import { orderUrl } from "@/lib/email/origin";

// Telling the OWNER a sale happened (2026-08-22).
//
// P1.8 of the Cubit & Coil Live milestone names four notifications: "order
// confirmation, payment confirmation, shipping confirmation, tracking
// (customer); new-order notification (owner)." The three customer ones exist —
// sendOrderConfirmation and notifyCustomerShipped. The owner one did not.
//
// So the chain the whole milestone is defined by — "purchase → pay → order is
// recorded → I RECEIVE THE ORDER → shipping information is available" — had a
// gap at the arrow that matters most to the person running the shop. An order
// arrived, the customer was thanked, and the owner found out by opening the
// dashboard and looking. For a business where somebody is waiting on a
// hand-wound product, that is the difference between shipping today and
// shipping whenever the owner next checks.
//
// A FIFTH STATE, kept apart from the four orderConfirmation.ts already names.
// An order can be paid, confirmed to the customer, shipped and tracked while
// its owner has never been told it exists. ownerNotifiedAt is the only column
// that says otherwise, and null means not told — including for every order
// written before it existed, which is the honest reading rather than a
// backfilled claim that somebody was emailed.
//
// EVERYTHING BELOW MIRRORS sendOrderConfirmation DELIBERATELY: the same claim-
// then-send idempotency, the same release-on-failure, the same
// configuration-checked-before-claiming, the same store-and-order pair rather
// than an id alone. Two notification paths with two different idempotency
// disciplines is how one of them ends up sending twice, and it would be
// whichever nobody was reading.

export interface SaleNotificationOrder {
  id: string;
  productName: string;
  quantity: number;
  amountInCents: number;
  buyerEmail: string;
  externalOrderId: string;
  shippingAddress: unknown;
}

export interface SaleNotificationStore {
  name: string;
  currency: string;
  /** Needed for the link to the order — the route names the business. */
  slug: string;
}

export type OwnerNotificationOutcome =
  | { sent: true }
  /** Another delivery of the same event already sent it. */
  | { sent: false; reason: "already_sent" }
  /** No Resend credential. An operator problem, not the owner's. */
  | { sent: false; reason: "email_not_configured" }
  /** The provider rejected it. Nothing landed, so trying again is safe. */
  | { sent: false; reason: "send_failed"; detail: string }
  /**
   * WE DO NOT KNOW WHETHER THE OWNER GOT IT.
   *
   * New with the runOnce migration, and it was always the real gap: the old
   * claim released on a caught failure but NOT on a crash, so a process dying
   * mid-send left ownerNotifiedAt set forever. The owner was never told and
   * nothing anywhere said so. That silence now has a name.
   */
  | { sent: false; reason: "indeterminate" }
  /** No such order for that store. */
  | { sent: false; reason: "not_found" };

const money = formatMoney;

/**
 * What the owner is told — pure, so the recipient, subject and body can be
 * asserted without an email provider existing.
 *
 * It reports the sale and nothing else. No advice, no "great news", no
 * suggestion of what to do next: the owner knows what a sale means, and the
 * shipping workflow is already where it belongs. J4 speaks in the Office; this
 * is a notification.
 */
export function buildOwnerSaleEmail(params: {
  order: SaleNotificationOrder;
  store: SaleNotificationStore;
  ownerEmail: string;
}): { to: string; subject: string; html: string } {
  const { order, store, ownerEmail } = params;
  const total = money(order.amountInCents, store.currency);
  const link = orderUrl(store.slug, order.id);
  const quantity = order.quantity > 1 ? ` &times;${order.quantity}` : "";

  // The address is shown only when one was actually captured. A digital order,
  // or one whose address never arrived, must not render an empty block that
  // reads as a missing delivery address rather than an absent requirement.
  const address = order.shippingAddress as Record<string, unknown> | null;
  const addressLine =
    address && typeof address === "object" && typeof address.line1 === "string"
      ? `<p>Ship to: ${[address.name, address.line1, address.city, address.postalCode, address.country]
          .filter((part): part is string => typeof part === "string" && part.length > 0)
          .join(", ")}</p>`
      : "";

  return {
    to: ownerEmail,
    // The subject carries the fact, because it is often all the owner reads on
    // a phone. A generic "You have a notification" would make them open it to
    // learn something the subject could have told them.
    subject: `New order — ${order.productName}${quantity} — ${total}`,
    html: [
      `<p>${store.name} has a new order.</p>`,
      `<p><strong>${order.productName}</strong>${quantity} — ${total}</p>`,
      `<p>Customer: ${order.buyerEmail}</p>`,
      addressLine,
      `<p>Order reference: ${order.externalOrderId}</p>`,
      // ============ THE WAY BACK INTO GENESIS (2026-09-01) ==========
      //
      // The email carried the provider's own reference and nothing that opened
      // the order. An owner reading "New order" on a phone had to remember
      // where Genesis lives, sign in, find Orders, and match a cs_live_ string
      // by eye — for the one email whose entire purpose is "go and deal with
      // this".
      //
      // Omitted rather than guessed when no origin is configured: a link that
      // 404s in a sale notification teaches an owner not to trust the next one.
      // See lib/email/origin.ts.
      link ? `<p><a href="${link}">Open this order in Genesis</a></p>` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

/**
 * Tell the owner about an order that has ALREADY COMMITTED — once.
 *
 * Called only after the transaction that created the Order has committed, so a
 * rolled-back order can never be announced: there is nothing to load.
 *
 * IDEMPOTENCY IS A CLAIM, NOT A CHECK, exactly as it is for the customer's
 * confirmation. `ownerNotifiedAt` is set by a conditional update that only
 * matches while it is still null, so two deliveries of the same webhook cannot
 * both win it. On failure the claim is released so the next delivery retries.
 */
export async function notifyOwnerOfSale(
  // The store is required alongside the order for the same reason
  // sendOrderConfirmation takes the pair: the claim is an updateMany, and
  // tenant isolation requires the scoping to be structural rather than
  // something a later edit could drop. A mismatched pair matches no row, so the
  // worst case is a notification not sent rather than one about another
  // tenant's sale.
  target: { orderId: string; storeId: string },
  send: EmailSender = sendEmail
): Promise<OwnerNotificationOutcome> {
  const { orderId, storeId } = target;

  // Checked before claiming. Claiming first would mark the owner as told on a
  // platform that cannot send anything at all.
  if (!isEmailConfigured()) {
    reportIssue(
      `order ${orderId} was not announced to the owner — email is not configured`,
      new Error("RESEND_API_KEY / EMAIL_FROM_ADDRESS are not set"),
      { subsystem: "email", stage: "order.owner_notification.unconfigured", storeId, extra: { orderId } }
    );
    return { sent: false, reason: "email_not_configured" };
  }

  // ============ READ FIRST, THEN RUN ONCE ==========================
  //
  // The claim column used to be the idempotency and is now the business fact:
  // "the owner was told, at this time". Exactly-once belongs to runOnce, which
  // brings the state this could never represent — a crash mid-send left the
  // column set forever and the owner silently un-notified.
  //
  // Mirrors notificationClaim.ts deliberately, as this file always has.
  const order = await prisma.order.findFirst({
    where: { id: orderId, storeId },
    include: { store: { select: { name: true, currency: true, slug: true, user: { select: { email: true } } } } },
  });
  if (!order) return { sent: false, reason: "not_found" };

  const outcome = await runOnce({
    key: `order-notification:ownerNotifiedAt:${orderId}`,
    operation: "email.ownerNotifiedAt",
    storeId,
    perform: async () => {
      await send(buildOwnerSaleEmail({ order, store: order.store, ownerEmail: order.store.user.email }));
      return { result: { sent: true } };
    },
  });

  switch (outcome.status) {
    case "performed":
      await prisma.order
        .updateMany({ where: { id: orderId, storeId, ownerNotifiedAt: null }, data: { ownerNotifiedAt: new Date() } })
        .catch(() => {
          reportIssue(`owner notification sent for ${orderId} but the claim column could not be written`, null, {
            subsystem: "email", stage: "order.owner_notification.record", storeId, extra: { orderId },
          });
        });
      return { sent: true };

    case "replayed":
    case "in_progress":
      return { sent: false, reason: "already_sent" };

    case "indeterminate":
      reportIssue(`owner notification for ${orderId} is indeterminate`, null, {
        subsystem: "email", stage: "order.owner_notification.indeterminate", storeId, extra: { orderId },
      });
      return { sent: false, reason: "indeterminate" };

    case "failed":
      reportIssue(`owner notification could not be sent for ${orderId}`, new Error(outcome.error), {
        subsystem: "email", stage: "order.owner_notification.send", storeId,
        extra: { orderId, detail: outcome.error },
      });
      return { sent: false, reason: "send_failed", detail: outcome.error };
  }
}
