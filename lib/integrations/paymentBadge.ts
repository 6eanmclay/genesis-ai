import type { IntegrationStatus } from "@prisma/client";

// What the payments page is allowed to tell an owner about a payment provider
// (2026-08-20).
//
// Both cards used to ask "is the row not DISCONNECTED?" and render a green
// Connected on the strength of it. Six real stores were shown "Connected" for
// Stripe accounts that had failed verification and could not take a cent — and
// PayPal went further, rendering Connected and "Needs attention" side by side,
// two contradictory answers to the only question the card exists to answer.
//
// A payments badge is not decoration. It is the owner's answer to "can my store
// take money right now?", so only a connection that actually verified may say
// yes. Extracted from the JSX because a rule this consequential should be
// assertable — see scripts/verify-payment-badge.ts.

export type PaymentBadge =
  /** Verified. The store can take money through this provider. */
  | { kind: "connected" }
  /** A connection exists but is not working. `label` is shown to the owner. */
  | { kind: "attention"; label: string }
  /** No connection at all. */
  | { kind: "none" };

export function paymentBadgeFor(status: IntegrationStatus | null | undefined): PaymentBadge {
  if (status === "CONNECTED") return { kind: "connected" };
  if (status == null || status === "DISCONNECTED") return { kind: "none" };
  // NEEDS_ATTENTION is the provider telling us something specific; FAILED is
  // ours. "Not working" is deliberately blunter than "needs attention" because
  // that is the blunter situation.
  return { kind: "attention", label: status === "NEEDS_ATTENTION" ? "Needs attention" : "Not working" };
}

/** True when there is a connection that cannot currently take payments. */
export function isBrokenConnection(status: IntegrationStatus | null | undefined): boolean {
  return paymentBadgeFor(status).kind === "attention";
}
