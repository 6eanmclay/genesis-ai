import { prisma } from "@/lib/prisma";
import { sendEmail, isEmailConfigured } from "@/lib/email/sendEmail";
import { reportIssue } from "@/lib/observability/reportIssue";
import { formatMoney } from "@/lib/money";
import type { EmailSender } from "./orderConfirmation";

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
}

export type OwnerNotificationOutcome =
  | { sent: true }
  /** Another delivery of the same event already sent it. */
  | { sent: false; reason: "already_sent" }
  /** No Resend credential. An operator problem, not the owner's. */
  | { sent: false; reason: "email_not_configured" }
  /** The provider rejected it. The claim is released so a retry can try again. */
  | { sent: false; reason: "send_failed"; detail: string }
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

  const claimed = await prisma.order.updateMany({
    where: { id: orderId, storeId, ownerNotifiedAt: null },
    data: { ownerNotifiedAt: new Date() },
  });
  if (claimed.count === 0) {
    // Two different reasons, told apart rather than collapsed: already sent, or
    // no such order for this store. An operator reading "already notified" for
    // an order that does not exist would be looking in entirely the wrong place.
    const exists = await prisma.order.findFirst({ where: { id: orderId, storeId }, select: { id: true } });
    return exists ? { sent: false, reason: "already_sent" } : { sent: false, reason: "not_found" };
  }

  const order = await prisma.order.findFirst({
    where: { id: orderId, storeId },
    include: { store: { select: { name: true, currency: true, user: { select: { email: true } } } } },
  });
  if (!order) {
    // Deleted between the claim and the read. Nothing to release.
    return { sent: false, reason: "not_found" };
  }

  // NO "the store has no owner address" BRANCH, deliberately. The first
  // version had one, and it was defensive code for a state the schema makes
  // impossible: Store.userId is required and User.email is a required String,
  // so a committed order always has an owner with an address. A handled case
  // that cannot occur reads as a real one and is never exercised.
  //
  // A blank address is still possible and needs no branch of its own — the
  // provider rejects it, the catch below releases the claim, and it is reported
  // as send_failed carrying the provider's own reason. One path, already tested.
  try {
    await send(buildOwnerSaleEmail({ order, store: order.store, ownerEmail: order.store.user.email }));
    return { sent: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    await prisma.order
      .update({ where: { id: orderId, storeId }, data: { ownerNotifiedAt: null } })
      .catch(() => {
        // If even the release fails the order stays marked and this owner does
        // not get a second attempt. Reported below either way.
      });
    reportIssue(`owner notification could not be sent for ${orderId}`, error, {
      subsystem: "email",
      stage: "order.owner_notification.send",
      storeId,
      extra: { orderId, detail },
    });
    return { sent: false, reason: "send_failed", detail };
  }
}
