import { prisma } from "@/lib/prisma";

export type PaymentProviderChoice = "STRIPE" | "PAYPAL";

// The one place checkout-provider policy lives. Today: prefer Stripe, then
// PayPal. Adding a new provider later (Square, Authorize.net, Apple Pay,
// Google Pay, ...) means adding a case here, not re-touching
// createCheckoutSession every time.
//
// No platform-wide fallback exists — payment routing is explicit and
// deterministic by design. A store with nothing connected is a real
// misconfiguration, not something to paper over with a shared account; the
// caller must have already gated on canStoreAcceptPayments, and
// publishStoreExecutable independently refuses to publish an unconnected
// store, so reaching this throw means both checks were bypassed.
export async function selectProvider(storeId: string): Promise<PaymentProviderChoice> {
  const connected = await prisma.storeIntegration.findMany({
    where: { storeId, provider: { in: ["STRIPE", "PAYPAL"] }, status: "CONNECTED" },
    select: { provider: true },
  });

  if (connected.some((i) => i.provider === "STRIPE")) return "STRIPE";
  if (connected.some((i) => i.provider === "PAYPAL")) return "PAYPAL";
  throw new Error(`Store ${storeId} has no connected payment provider — cannot select a checkout provider.`);
}
