import { prisma } from "@/lib/prisma";
import { sendEmail, isEmailConfigured } from "@/lib/email/sendEmail";
import { reportIssue } from "@/lib/observability/reportIssue";
import { SECURITY_EVENTS, SECURITY_EVENT_LABEL, type SecurityEventKind } from "./events";
import type { EmailSender } from "@/lib/orders/orderConfirmation";

// TELLING AN OWNER SOMETHING HAPPENED TO THEIR ACCOUNT (Security & Trust step
// 8, last in the sequence because everything else emits into it).
//
// SENDING IS EXTERNALLY BLOCKED HERE and stays so: there is no RESEND_API_KEY
// in this environment, and this project's standing rule is that a real
// dependency is never mocked. But the SENDER IS INJECTABLE, exactly as
// sendOrderConfirmation's is, so every decision — whether to notify, about
// what, to whom, and what it says — is provable without a provider existing.
// That is the half that can be wrong in a way nobody notices.
//
// WHAT IS WORTH AN EMAIL IS NOT WHAT IS WORTH A LOG LINE. The history records
// everything; this interrupts somebody. A successful sign-in is the most
// common event on the account and mailing it would train the owner to ignore
// exactly the messages this exists to send. So the list below is short, and it
// is the list of things an owner would want to be wrong about.

/**
 * The events that are worth an owner's attention away from the screen.
 *
 * Every one of these is either an attacker's next move or something the owner
 * did not do. A failed sign-in is deliberately ABSENT — people mistype their
 * own passwords constantly, and a mail for each would be noise that buries the
 * real ones. The throttle firing is present, because that is a pattern rather
 * than a slip.
 */
export const NOTIFIABLE_EVENTS: readonly SecurityEventKind[] = [
  SECURITY_EVENTS.signInBlocked,
  SECURITY_EVENTS.passwordChanged,
  SECURITY_EVENTS.twoFactorEnabled,
  SECURITY_EVENTS.twoFactorDisabled,
  SECURITY_EVENTS.recoveryCodesRegenerated,
  SECURITY_EVENTS.recoveryCodeUsed,
  SECURITY_EVENTS.allSessionsRevoked,
];

export function isNotifiable(kind: SecurityEventKind): boolean {
  return NOTIFIABLE_EVENTS.includes(kind);
}

/**
 * What the owner reads.
 *
 * Pure, so the recipient, subject and body are assertable without a provider.
 * It states what happened and what to do if it was not them — and nothing
 * else. No link that could be phished back at them, no "click here to secure
 * your account": a security email that trains people to click links is a
 * liability, and the owner already knows where their settings are.
 */
export function buildSecurityEmail(params: {
  kind: SecurityEventKind;
  to: string;
  device: string | null;
  at: Date;
}): { to: string; subject: string; html: string } {
  const what = SECURITY_EVENT_LABEL[params.kind];
  return {
    to: params.to,
    // The subject carries the fact, because on a phone it is often all that is
    // read — and this is the one message where knowing at a glance matters.
    subject: `Genesis security: ${what.toLowerCase()}`,
    html: [
      `<p>${what} on your Genesis account.</p>`,
      params.device ? `<p>Device: ${params.device}</p>` : "",
      `<p>When: ${params.at.toUTCString()}</p>`,
      `<p>If this was you, there is nothing to do.</p>`,
      `<p>If it was not, change your password and sign out of your other devices from Account security.</p>`,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

export type NotifyOutcome =
  | { sent: true }
  /** Not the kind of thing worth interrupting somebody about. */
  | { sent: false; reason: "not_notifiable" }
  /** No Resend credential. An operator problem, not the owner's. */
  | { sent: false; reason: "email_not_configured" }
  /** The provider refused it. */
  | { sent: false; reason: "send_failed"; detail: string };

/**
 * Tell the owner, if this is worth telling them.
 *
 * NEVER THROWS, and never blocks the act it describes. This is called
 * alongside recordSecurityEvent from paths like "the owner just turned 2FA
 * off" — failing that operation because an email would not send would be the
 * security feature denying the owner control of their own account.
 */
export async function notifyOfSecurityEvent(
  input: {
    userId: string;
    kind: SecurityEventKind;
    device?: string | null;
    at?: Date;
  },
  send: EmailSender = sendEmail
): Promise<NotifyOutcome> {
  if (!isNotifiable(input.kind)) return { sent: false, reason: "not_notifiable" };

  // Checked before doing any work, so an unconfigured platform reports one
  // clear operator problem rather than a provider error per event.
  if (!isEmailConfigured()) {
    return { sent: false, reason: "email_not_configured" };
  }

  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { email: true },
  });
  // User.email is required by the schema, so this is the deleted-between-write
  // -and-send case rather than a missing address.
  if (!user) return { sent: false, reason: "send_failed", detail: "no such account" };

  try {
    await send(
      buildSecurityEmail({
        kind: input.kind,
        to: user.email,
        device: input.device ?? null,
        at: input.at ?? new Date(),
      })
    );
    return { sent: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    reportIssue(`security notification ${input.kind} could not be sent`, error, {
      subsystem: "security",
      stage: "security_notification.send",
      extra: { kind: input.kind, userId: input.userId },
    });
    return { sent: false, reason: "send_failed", detail };
  }
}
