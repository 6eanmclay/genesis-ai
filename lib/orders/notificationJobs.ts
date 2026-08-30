import { enqueue } from "@/lib/jobs/queue";
import type { JobHandler } from "@/lib/jobs/queue";
import { sendOrderConfirmation } from "./orderConfirmation";
import { notifyCustomerDelivered } from "./deliveryNotification";
import { notifyCustomerRefunded } from "./refundNotification";
import { notifyOwnerOfSale } from "./notifyOwnerOfSale";
import { reportIssue } from "@/lib/observability/reportIssue";
import type { EmailSender } from "./orderConfirmation";

// A NOTIFICATION THAT CAN TRY AGAIN BEFORE TOMORROW.
//
// ============ WHAT THE SWEEP COULD NOT DO (2026-08-30) =================
//
// The sweep found due notifications and sent them inline, inside the cron. So a
// send that failed waited a FULL DAY for the next tick — there was no other
// retry anywhere — and a cron that died half way through a batch left the rest
// of that day's notifications unsent with nothing recording which.
//
// As a job each notification retries on its own backoff, survives a runner
// dying, and dead-letters where somebody can see it instead of dissolving into
// a daily loop that never reports.
//
// ============ WHAT DID NOT MOVE, AND WHY ==============================
//
// The payment path still sends inline. app/api/webhooks/stripe and the PayPal
// return route call sendOrderConfirmation and notifyOwnerOfSale directly, and
// they stay that way: a customer is waiting for that email, and making it
// asynchronous would trade a real second of their experience for a tidier
// diagram. The sweep is the backstop for when that inline attempt did not
// happen, and the backstop is what belongs in a queue.
//
// ============ THE JOB IS NOT THE IDEMPOTENCY ==========================
//
// Each send is already exactly-once through runOnce, keyed on the order and the
// notification kind. The job's own idempotency key stops the SWEEP enqueuing
// the same work twice; runOnce stops the SEND happening twice. Two different
// duplications, and the queue only prevents one of them.

export type NotificationKind = "confirmation" | "delivery" | "refund" | "ownerSale";

export interface NotificationPayload {
  orderId: string;
  storeId: string;
  kind: NotificationKind;
}

/** One key per order per kind, so a re-sweep is not a second job. */
export function notificationJobKey(kind: NotificationKind, orderId: string): string {
  return `notification:${kind}:${orderId}`;
}

export async function enqueueNotification(payload: NotificationPayload): Promise<boolean> {
  const outcome = await enqueue({
    kind: "notification.order",
    idempotencyKey: notificationJobKey(payload.kind, payload.orderId),
    storeId: payload.storeId,
    payload,
  });
  return outcome.created;
}

/**
 * Send one notification.
 *
 * THROWS on a failure that should be retried, and returns quietly on one that
 * should not. That distinction is the whole contract with the queue: throwing
 * means "try again later", returning means "there is nothing more to do here".
 *
 * `indeterminate` returns rather than throws. Retrying might email a customer
 * twice about the same order, and the queue's job is to repeat work safely, not
 * to guess. It is already reported and visible in the outbound operations
 * anybody can list.
 */
/**
 * ============ WHY A FACTORY (2026-08-30) ==========================
 *
 * Every notification path in this codebase takes an injectable EmailSender, so
 * a suite can prove a send happened without reaching Resend — the dependency
 * Phase 1 was built not to wait for.
 *
 * A job carries a JSON payload and nothing else, so a handler cannot be handed
 * a function. Moving the sweep onto the queue would therefore have made the
 * whole notification path untestable, which is too high a price for a tidier
 * cron.
 *
 * `drain()` already takes its handlers as an argument, so the seam is there:
 * production registers the default, a suite builds its own with a recording
 * sender and drains with that. No test-only branch in production code, and no
 * seam that replaces the thing under test.
 */
export function makeNotificationHandler(send?: EmailSender): JobHandler {
  return async ({ job }) => {
  const payload = job.payload as NotificationPayload;
  const target = { orderId: payload.orderId, storeId: payload.storeId };

  const outcome =
    payload.kind === "confirmation"
      ? await sendOrderConfirmation(target, send)
      : payload.kind === "delivery"
        ? await notifyCustomerDelivered(target, send)
        : payload.kind === "refund"
          ? await notifyCustomerRefunded(target, send)
          : await notifyOwnerOfSale(target, send);

  if (outcome.sent) return;

  switch (outcome.reason) {
    case "already_sent":
    case "not_found":
      // Nothing more to do, and not a failure. A second delivery of the same
      // event, or an order that has since gone.
      return;

    case "email_not_configured":
      // NOT retried. Without a Resend key every notification on the platform
      // would retry to exhaustion and dead-letter, burying the one signal that
      // matters — that email is not configured — under hundreds of identical
      // failures. Reported once by the sender itself.
      return;

    case "indeterminate":
      // See the doc comment. Reported, not retried.
      return;

    case "send_failed":
      // The provider refused and nothing landed, so a retry is safe and is
      // exactly what the queue is for.
      throw new Error(`${payload.kind} notification failed: ${outcome.detail}`);

    default:
      reportIssue(`unrecognised notification outcome for order ${payload.orderId}`, null, {
        subsystem: "email",
        stage: "notification.job",
        storeId: payload.storeId,
      });
      return;
  }
  };
}

/** What production registers. */
export const notificationJobHandler: JobHandler = makeNotificationHandler();
