import { prisma } from "@/lib/prisma";
import { isEmailConfigured, sendEmail } from "@/lib/email/sendEmail";
import { reportIssue } from "@/lib/observability/reportIssue";
import type { EmailSender } from "./orderConfirmation";
import { runOnce } from "@/lib/outbound/runOnce";

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
  | { sent: false; reason: "send_failed"; detail: string }
  /**
   * WE DO NOT KNOW WHETHER THE CUSTOMER GOT IT.
   *
   * New with the runOnce migration, and it was always the real gap: the old
   * claim released on a caught failure but NOT on a crash, so a process dying
   * mid-send left the column set forever. The customer was never emailed and
   * nothing anywhere said so. That silence is now a state with a name.
   */
  | { sent: false; reason: "indeterminate" };

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

  // Configuration is checked BEFORE anything is claimed — see step 1 above.
  // Unchanged by the migration, and still the first thing that happens.
  if (!isEmailConfigured()) {
    reportIssue(`order ${orderId} — ${label} was not sent because email is not configured`, null, {
      subsystem: "email",
      stage: `order.${claim}.unconfigured`,
      storeId,
    });
    return { sent: false, reason: "email_not_configured" };
  }

  // ============ THE ORDER IS READ BEFORE THE CLAIM NOW ==============
  //
  // It used to be read after, to avoid the work when already notified. The
  // sweep already filters on the column being null, so that saving was
  // theoretical — and reading first keeps "no such order" a distinct outcome
  // rather than something that has to be inferred from a thrown error inside
  // the send.
  const loaded = await load();
  if (!loaded) return { sent: false, reason: "not_found" };

  // ============ IDEMPOTENCY MOVED, THE COLUMN DID NOT ===============
  //
  // The claim column used to BE the idempotency. It is now the business fact —
  // "the customer was told, at this time" — which is what the owner-facing
  // surfaces read it for, and it is written only after a send that really
  // happened.
  //
  // Exactly-once is runOnce's job, and it brings the state the column could
  // never represent: a crash mid-send is indeterminate rather than silently
  // claimed forever.
  const outcome = await runOnce({
    key: `order-notification:${claim}:${orderId}`,
    operation: `email.${claim}`,
    storeId,
    perform: async () => {
      await send(build(loaded));
      // An email has no provider-side object to point at, so there is no
      // externalRef. Honest null rather than an invented one.
      return { result: { sent: true } };
    },
  });

  switch (outcome.status) {
    case "performed":
      await prisma.order
        .updateMany({ where: { id: orderId, storeId, [claim]: null }, data: { [claim]: new Date() } })
        .catch(() => {
          // The email went. Failing to record that is worth reporting and is
          // not worth telling the caller the send failed — it did not.
          reportIssue(`order ${orderId} — ${label} sent but the claim column could not be written`, null, {
            subsystem: "email",
            stage: `order.${claim}.record`,
            storeId,
          });
        });
      return { sent: true };

    case "replayed":
    case "in_progress":
      // Already sent, or being sent right now by somebody else. The caller's
      // response to both is identical and always has been.
      return { sent: false, reason: "already_sent" };

    case "indeterminate":
      reportIssue(`order ${orderId} — ${label} is indeterminate; the customer may or may not have it`, null, {
        subsystem: "email",
        stage: `order.${claim}.indeterminate`,
        storeId,
      });
      return { sent: false, reason: "indeterminate" };

    case "failed":
      reportIssue(`order ${orderId} — ${label} could not be sent`, new Error(outcome.error), {
        subsystem: "email",
        stage: `order.${claim}.send`,
        storeId,
      });
      return { sent: false, reason: "send_failed", detail: outcome.error };
  }
}

