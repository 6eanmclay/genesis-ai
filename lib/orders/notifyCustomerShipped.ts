import { sendEmail, isEmailConfigured } from "@/lib/email/sendEmail";

// Priority 2 (shipping, 2026-08-09) — the real customer-facing half of
// "tracking number → shipped order... customer notification" (Sean).
// Reuses the same sendEmail primitive password reset already uses, which
// never pretends to send: with no real RESEND_API_KEY configured, this
// reports honestly rather than silently succeeding.
//
// 2026-08-20 — it now reports that to the OWNER, not just to a console line.
// Before this, buying a label said "Bought a USPS label — tracking 94001..."
// and nothing else, whether or not the customer had actually been told. The
// owner would reasonably believe the buyer had their tracking number, and on
// a store with no email configured — which is every store today, since there
// is no Resend account yet — the buyer had heard nothing at all. A silence
// the owner cannot see is worse than an error they can.

export type ShippedNotification =
  | { notified: true }
  | { notified: false; reason: "email_not_configured" }
  | { notified: false; reason: "send_failed"; detail: string }
  /** A previous label purchase already told them. Not a failure. */
  | { notified: false; reason: "already_notified" };

export async function notifyCustomerShipped(params: {
  to: string;
  productName: string;
  carrier: string;
  trackingNumber: string;
  trackingUrl: string | null;
}): Promise<ShippedNotification> {
  if (!isEmailConfigured()) {
    console.error(
      `[notifyCustomerShipped] email isn't configured — customer ${params.to} was not notified that ${params.productName} shipped`
    );
    return { notified: false, reason: "email_not_configured" };
  }

  const trackingLine = params.trackingUrl
    ? `<p>Track your package: <a href="${params.trackingUrl}">${params.trackingUrl}</a></p>`
    : `<p>Tracking number: ${params.trackingNumber} (${params.carrier})</p>`;

  try {
    await sendEmail({
      to: params.to,
      subject: `Your order has shipped — ${params.productName}`,
      html: `
      <p>Good news — <strong>${params.productName}</strong> is on its way.</p>
      ${trackingLine}
    `,
    });
    return { notified: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    console.error(`[notifyCustomerShipped] send failed for ${params.to}: ${detail}`);
    return { notified: false, reason: "send_failed", detail };
  }
}

/**
 * What the owner is told after a label is bought — pure.
 *
 * The label is already paid for by the time this runs, so the sentence must
 * never read as though the purchase failed. But it must also never imply the
 * customer knows their order shipped when they do not: the owner is the only
 * one who can put that right, and they can only do it if they are told.
 */
export function labelPurchaseMessage(params: {
  carrier: string;
  trackingNumber: string;
  notification: ShippedNotification;
}): string {
  const bought = `Bought a ${params.carrier} label — tracking ${params.trackingNumber}.`;

  if (params.notification.notified) {
    return `${bought} The customer has been emailed the tracking number.`;
  }
  if (params.notification.reason === "already_notified") {
    // Not a warning: they were told the first time, and telling them twice
    // about one shipment would be worse than not repeating it.
    return `${bought} The customer had already been notified about this shipment.`;
  }
  if (params.notification.reason === "email_not_configured") {
    return `${bought} The customer was NOT emailed — Genesis can't send email yet, so you'll need to send them the tracking number yourself.`;
  }
  return `${bought} The customer could NOT be emailed (${params.notification.detail}) — you'll need to send them the tracking number yourself.`;
}
