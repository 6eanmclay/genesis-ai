import { prisma } from "@/lib/prisma";
import { isEmailConfigured, sendEmail } from "@/lib/email/sendEmail";
import { reportIssue } from "@/lib/observability/reportIssue";
import type { EmailSender } from "./orderConfirmation";

// TELLING SOMEBODY SOMETHING, EXACTLY ONCE.
//
// ============ WHY THIS EXISTS (2026-08-29) =============================
//
// orderConfirmation.ts and notifyOwnerOfSale.ts already do this, correctly and
// identically, and two more events needed the same thing: delivery and refund.
// Writing it a third and fourth time is how one of the four ends up checking
// before it claims.
//
// So the sequence lives here once:
//
//   1. Is email configured? If not, report and stop — BEFORE claiming.
//      Claiming first would mark an order notified on a platform that cannot
//      send anything at all, and nothing would ever try again.
//   2. Claim, with a conditional update that only matches while the column is
//      still null. Two concurrent webhook deliveries cannot both win it. A
//      check-then-send would let both pass the check and email twice.
//   3. Send.
//   4. On failure, RELEASE the claim so a redelivery or the sweep can retry.
//
// THE EXISTING TWO ARE DELIBERATELY NOT REFACTORED ONTO THIS. They are verified,
// they are on the money path, and rewriting a working idempotency claim to save
// duplication is a trade nobody asked for. This is what new events use; if the
// old two are ever touched for another reason, they can adopt it then.

/** Which claim column this notification is won with. */
export type NotificationClaim = "deliveryNotifiedAt" | "refundNotifiedAt";

export type NotificationOutcome =
  | { sent: true }
  | { sent: false; reason: "email_not_configured" }
  | { sent: false; reason: "already_sent" }
  | { sent: false; reason: "not_found" }
  | { sent: false; reason: "send_failed"; detail: string };

export interface ClaimAndSendInput<T> {
  orderId: string;
  /**
   * REQUIRED, and paired with the id in every write.
   *
   * The tenant-isolation extension guards update/updateMany, and a mismatched
   * pair matches no row — so the worst case is a notification that is not sent
   * rather than one sent about another tenant's order.
   */
  storeId: string;
  claim: NotificationClaim;
  /** Loads what the email needs, after the claim is won. */
  load: () => Promise<T | null>;
  /** Builds the email. Pure: given the same order it produces the same message. */
  build: (loaded: T) => { to: string; subject: string; html: string; fromName?: string };
  /** What to call this in an operator report. */
  label: string;
  send?: EmailSender;
}

export async function claimAndSend<T>(input: ClaimAndSendInput<T>): Promise<NotificationOutcome> {
  const { orderId, storeId, claim, load, build, label } = input;
  const send = input.send ?? sendEmail;

  // Configuration is checked BEFORE claiming — see step 1 above.
  if (!isEmailConfigured()) {
    reportIssue(`order ${orderId} — ${label} was not sent because email is not configured`, null, {
      subsystem: "email",
      stage: `order.${claim}.unconfigured`,
      storeId,
    });
    return { sent: false, reason: "email_not_configured" };
  }

  const claimed = await prisma.order.updateMany({
    where: { id: orderId, storeId, [claim]: null },
    data: { [claim]: new Date() },
  });
  if (claimed.count === 0) {
    // Nothing was claimed. Two very different reasons, told apart rather than
    // collapsed: already notified, or no such order for this store at all.
    const exists = await prisma.order.findFirst({
      where: { id: orderId, storeId },
      select: { id: true },
    });
    return exists ? { sent: false, reason: "already_sent" } : { sent: false, reason: "not_found" };
  }

  const loaded = await load();
  if (!loaded) {
    // Deleted between the claim and the read. Release it: a row that comes
    // back (it will not) should not be permanently marked.
    await releaseClaim(orderId, storeId, claim);
    return { sent: false, reason: "not_found" };
  }

  try {
    await send(build(loaded));
    return { sent: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    await releaseClaim(orderId, storeId, claim);
    reportIssue(`order ${orderId} — ${label} could not be sent`, error, {
      subsystem: "email",
      stage: `order.${claim}.send`,
      storeId,
    });
    return { sent: false, reason: "send_failed", detail };
  }
}

/**
 * Give the claim back so something can try again.
 *
 * Swallows its own failure deliberately: if even the release fails, the order
 * stays marked and this customer gets no second attempt — which is bad, and is
 * exactly why the caller reports the original failure either way. Throwing here
 * would replace a missing email with a failed webhook, and the webhook is the
 * thing that must not fail.
 */
async function releaseClaim(orderId: string, storeId: string, claim: NotificationClaim): Promise<void> {
  await prisma.order
    .update({ where: { id: orderId, storeId }, data: { [claim]: null } })
    .catch(() => {});
}
