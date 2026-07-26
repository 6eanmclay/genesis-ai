import { prisma } from "@/lib/prisma";

export type PaymentProviderChoice = "STRIPE" | "PAYPAL";

// The one place checkout-provider policy lives. Today: prefer Stripe, then
// PayPal, then the platform-wide Stripe fallback. Adding a new provider
// later (Square, Authorize.net, Apple Pay, Google Pay, ...) means adding a
// case here, not re-touching createCheckoutSession every time.
export async function selectProvider(storeId: string): Promise<PaymentProviderChoice> {
  const connected = await prisma.storeIntegration.findMany({
    where: { storeId, provider: { in: ["STRIPE", "PAYPAL"] }, status: "CONNECTED" },
    select: { provider: true },
  });

  if (connected.some((i) => i.provider === "STRIPE")) return "STRIPE";
  if (connected.some((i) => i.provider === "PAYPAL")) return "PAYPAL";
  return "STRIPE"; // platform-wide fallback key, existing behavior
}
