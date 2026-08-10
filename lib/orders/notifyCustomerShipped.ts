import { sendEmail, isEmailConfigured } from "@/lib/email/sendEmail";

// Priority 2 (shipping, 2026-08-09) — the real customer-facing half of
// "tracking number → shipped order... customer notification" (Sean).
// Reuses the same sendEmail primitive password reset already uses, which
// never pretends to send: with no real RESEND_API_KEY configured, this
// throws honestly rather than silently succeeding — same named gap as the
// rest of this codebase's email sending (Marketing Engine M3's own pause).
// The caller (purchaseShippingLabelExecutable) already treats a failure
// here as non-fatal to the label purchase itself, so this is free to fail
// loudly.
export async function notifyCustomerShipped(params: {
  to: string;
  productName: string;
  carrier: string;
  trackingNumber: string;
  trackingUrl: string | null;
}): Promise<void> {
  if (!isEmailConfigured()) {
    console.error(
      `[notifyCustomerShipped] email isn't configured — customer ${params.to} was not notified that ${params.productName} shipped`
    );
    return;
  }

  const trackingLine = params.trackingUrl
    ? `<p>Track your package: <a href="${params.trackingUrl}">${params.trackingUrl}</a></p>`
    : `<p>Tracking number: ${params.trackingNumber} (${params.carrier})</p>`;

  await sendEmail({
    to: params.to,
    subject: `Your order has shipped — ${params.productName}`,
    html: `
      <p>Good news — <strong>${params.productName}</strong> is on its way.</p>
      ${trackingLine}
    `,
  });
}
