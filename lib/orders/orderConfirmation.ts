import { prisma } from "@/lib/prisma";
import { formatMoney } from "@/lib/money";
import { sendEmail, isEmailConfigured } from "@/lib/email/sendEmail";
import { reportIssue } from "@/lib/observability/reportIssue";
import { runOnce } from "@/lib/outbound/runOnce";

// Telling the customer their order exists (2026-08-20).
//
// THE GAP. There was no order-confirmation path at all. Tracing every caller:
// the Stripe webhook committed the Order and scheduled observation sweeps, the
// PayPal return committed the Order and redirected, and the only customer email
// anywhere in the codebase was notifyCustomerShipped — called once, from the
// shipping-label purchase, which happens days later if it happens at all.
//
// So a customer paid, saw a success page, and then heard nothing from the
// business until the owner manually bought a label. Whatever receipt Stripe or
// PayPal sends is the payment processor's, not the store's.
//
// (notifyCustomerShipped is NOT misnamed and is NOT doubling as a confirmation
// mechanism — that was worth checking and it came back clean. Its name matches
// its one caller exactly.)
//
// FOUR STATES, kept apart on purpose:
//
//   status               paid | refunded          — the money
//   fulfillmentStatus    unfulfilled | fulfilled  — the owner's acknowledgment
//   trackingNumber       set                      — a label exists
//   confirmationSentAt   set                      — THE CUSTOMER WAS TOLD
//
// The fourth had no representation before this. It is not interchangeable with
// the others: an order can be paid and unconfirmed, fulfilled without the buyer
// ever being emailed, or confirmed and never shipped.

export interface ConfirmationOrder {
  id: string;
  buyerEmail: string;
  productName: string;
  amountInCents: number;
  externalOrderId: string;
  selectedShippingCarrier: string | null;
  selectedShippingService: string | null;
  selectedShippingEstDays: number | null;
  /**
   * WHAT THEY ACTUALLY BOUGHT (2026-08-29).
   *
   * `productName` on a multi-item order is "Copper Ring and 2 more" — which is
   * an honest label and a poor receipt. A customer checking what they were
   * charged for gets one name and a count.
   *
   * The lines have existed since the bag shipped; nothing read them. An order
   * placed through the single-product checkout has none, and then the summary
   * line above is the whole truth and this stays empty.
   */
  items: ConfirmationLine[];
}

/** One line of a receipt. */
export interface ConfirmationLine {
  productName: string;
  quantity: number;
  subtotalInCents: number;
}

export interface ConfirmationStore {
  name: string;
  // The store's own currency (2026-08-22). This email quotes the customer a
  // total they have just been charged; a hardcoded dollar sign made that
  // figure a claim about which money left their account.
  currency: string;
}

export type ConfirmationOutcome =
  | { sent: true }
  /** Another delivery of the same event already sent it. */
  | { sent: false; reason: "already_sent" }
  /** No Resend credential. An operator problem, not a customer one. */
  | { sent: false; reason: "email_not_configured" }
  /** The provider rejected it. Nothing landed, so a retry is safe. */
  | { sent: false; reason: "send_failed"; detail: string }
  /**
   * WE DO NOT KNOW WHETHER THE CUSTOMER GOT IT.
   *
   * The fourth private idempotency implementation in this codebase, and the one
   * the migration nearly missed — found by a test asserting the crash case
   * against the sweep. Like the other three, the old claim released on a CAUGHT
   * failure but not on a crash: a process dying mid-send left
   * confirmationSentAt set forever with nobody emailed and nothing saying so.
   */
  | { sent: false; reason: "indeterminate" }
  /**
   * No such order for that store — it rolled back, was deleted, or the
   * order/store pair does not match.
   *
   * Distinct from "already_sent" on purpose. Both fail to claim, but reporting
   * a non-existent order as already confirmed is a false statement, and it is
   * the one an operator would be reading while trying to work out why a
   * customer never heard anything.
   */
  | { sent: false; reason: "not_found" };

/**
 * The email itself — pure, so the exact recipient, subject and body can be
 * asserted without an email provider existing.
 *
 * Everything comes from the order and its OWN store. Nothing is looked up by a
 * caller-supplied id, so a confirmation cannot describe one tenant's sale using
 * another tenant's name.
 */
export function buildConfirmationEmail(params: {
  order: ConfirmationOrder;
  store: ConfirmationStore;
}): { to: string; subject: string; html: string; fromName: string } {
  const { order, store } = params;
  const total = formatMoney(order.amountInCents, store.currency);

  // Shipping is mentioned only when the customer actually chose a service.
  // Inventing "ships in 3-5 days" for an order with no shipping selection would
  // be exactly the kind of confident guess this codebase refuses elsewhere.
  const shippingLine =
    order.selectedShippingCarrier && order.selectedShippingService
      ? `<p>Shipping: ${order.selectedShippingCarrier} ${order.selectedShippingService}${
          order.selectedShippingEstDays !== null
            ? ` — estimated ${order.selectedShippingEstDays} business day${order.selectedShippingEstDays === 1 ? "" : "s"}`
            : ""
        }</p>`
      : "";

  // ============ ONE LINE PER THING BOUGHT ==========================
  //
  // Only when there is more than one. A single-line order would render a
  // one-row table under a heading that already said the same thing, and the
  // summary line below is exactly right for it.
  //
  // The total stays the ORDER total from the row itself — never the sum of
  // these lines. If the two ever disagreed, the number the customer was
  // actually charged is the one on the order, and recomputing it here would
  // quietly show them a different figure from their bank statement.
  const itemLines =
    order.items.length > 1
      ? [
          `<ul>`,
          ...order.items.map(
            (line) =>
              `<li>${line.quantity} × ${line.productName} — ${formatMoney(line.subtotalInCents, store.currency)}</li>`,
          ),
          `</ul>`,
        ].join("")
      : "";

  return {
    to: order.buyerEmail,
    subject: `Your order from ${store.name}`,
    // The store's own name in front of the address, so the customer sees who
    // they bought from rather than a platform they have never heard of.
    fromName: store.name,
    html: [
      `<p>Thank you — ${store.name} has received your order.</p>`,
      itemLines
        ? `<p><strong>Your order</strong> — ${total}</p>${itemLines}`
        : `<p><strong>${order.productName}</strong> — ${total}</p>`,
      shippingLine,
      // The reference a human can quote back. Without it a customer with a
      // problem has nothing to give anyone.
      `<p>Order reference: ${order.externalOrderId}</p>`,
      `<p>You'll hear from us again when it ships.</p>`,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

/** Injected in tests, so the decision and payload are provable without sending. */
export type EmailSender = (input: {
  to: string;
  subject: string;
  html: string;
  /** The store's display name, when the email is sent on a store's behalf. */
  fromName?: string;
}) => Promise<void>;

/**
 * Send the confirmation for an order that has ALREADY COMMITTED — once.
 *
 * Called only after the transaction that created the Order has committed, so a
 * rolled-back order can never be confirmed: there is nothing to load.
 *
 * IDEMPOTENCY IS A CLAIM, NOT A CHECK. `confirmationSentAt` is set by a
 * conditional update that only matches while it is still null, so two
 * concurrent deliveries of the same Stripe event cannot both win it. A
 * check-then-send would let both pass the check and email the customer twice.
 *
 * On failure the claim is RELEASED, so the next delivery retries rather than
 * the order being permanently marked as told when it never was. The one window
 * this leaves is a crash between claiming and releasing, which loses that
 * email — chosen deliberately over the alternative, since a duplicate
 * confirmation is a worse thing to send than a missing one is to lose, and the
 * owner can see the state either way.
 */
export async function sendOrderConfirmation(
  // The STORE is required alongside the order, not derived from it.
  //
  // The tenant-isolation guard rejected the first version of this — the claim
  // was an Order.updateMany with no store scoping — and it was right to. Taking
  // the pair makes the scoping structural rather than something a future edit
  // could quietly drop, and a mismatched pair matches no row, so the worst case
  // is a confirmation that is not sent rather than one sent about the wrong
  // tenant's order.
  target: { orderId: string; storeId: string },
  send: EmailSender = sendEmail
): Promise<ConfirmationOutcome> {
  const { orderId, storeId } = target;
  // Configuration is checked BEFORE claiming. Claiming first would mark the
  // order confirmed on a platform that cannot send anything at all.
  if (!isEmailConfigured()) {
    reportIssue(
      `order ${orderId} was not confirmed to the customer — email is not configured`,
      new Error("RESEND_API_KEY / EMAIL_FROM_ADDRESS are not set"),
      {
        subsystem: "email",
        stage: "order.confirmation.unconfigured",
        storeId,
        extra: { orderId },
      }
    );
    return { sent: false, reason: "email_not_configured" };
  }

  // ============ READ FIRST, THEN RUN ONCE ==========================
  //
  // The claim column is now the business fact — "the customer was sent their
  // receipt, at this time" — and exactly-once belongs to runOnce, which can
  // represent the state a column never could.
  const order = await prisma.order.findFirst({
    where: { id: orderId, storeId },
    include: {
      store: { select: { name: true, currency: true } },
      // Ordered so the receipt reads the same way twice. Without an explicit
      // order the rows come back however Postgres feels, and a customer
      // comparing two copies of their own receipt would see them differ.
      items: {
        select: { productName: true, quantity: true, subtotalInCents: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!order) return { sent: false, reason: "not_found" };

  const outcome = await runOnce({
    key: `order-notification:confirmationSentAt:${orderId}`,
    operation: "email.confirmationSentAt",
    storeId,
    perform: async () => {
      await send(buildConfirmationEmail({ order, store: order.store }));
      return { result: { sent: true } };
    },
  });

  switch (outcome.status) {
    case "performed":
      await prisma.order
        .updateMany({ where: { id: orderId, storeId, confirmationSentAt: null }, data: { confirmationSentAt: new Date() } })
        .catch(() => {
          reportIssue(`order ${orderId} was confirmed but the claim column could not be written`, null, {
            subsystem: "email", stage: "order.confirmation.record", storeId, extra: { orderId },
          });
        });
      return { sent: true };

    case "replayed":
    case "in_progress":
      return { sent: false, reason: "already_sent" };

    case "indeterminate":
      reportIssue(`order confirmation for ${orderId} is indeterminate`, null, {
        subsystem: "email", stage: "order.confirmation.indeterminate", storeId, extra: { orderId },
      });
      return { sent: false, reason: "indeterminate" };

    case "failed":
      reportIssue(`order confirmation could not be sent for ${orderId}`, new Error(outcome.error), {
        subsystem: "email", stage: "order.confirmation.send", storeId,
        extra: { orderId, detail: outcome.error },
      });
      return { sent: false, reason: "send_failed", detail: outcome.error };
  }
}
