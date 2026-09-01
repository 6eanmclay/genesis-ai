import Stripe from "stripe";
import { prisma } from "@/lib/prisma";
import { registerFinancialsProvider, financialsProviderFor } from "./provider";
import { makeStripeFinancialsProvider, type StripeFinancialsClient } from "./stripeFinancials";
import type { FinancialsResult } from "./types";

// WHICH PROVIDER ANSWERS FOR THIS BUSINESS.
//
// ============ RESOLVED FROM THE CONNECTION, NOT FROM A GUESS ===========
//
// A business's money lives wherever its payment rail is connected. This asks
// the integration table rather than assuming Stripe, so the day a PayPal
// implementation exists it is a registration and not a rewrite of the caller.

let registered = false;

/**
 * The platform client, built lazily.
 *
 * Constructed per call rather than at import time, deliberately: the connector
 * learned this the hard way — a module-level `new Stripe(...)` made merely
 * IMPORTING the file throw when the key was absent, which took down surfaces
 * that had nothing to do with payments.
 */
function platformClient(): StripeFinancialsClient {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set, so Stripe cannot be reached.");
  return new Stripe(key) as unknown as StripeFinancialsClient;
}

function ensureRegistered(): void {
  if (registered) return;
  registerFinancialsProvider(makeStripeFinancialsProvider(platformClient));
  registered = true;
}

/**
 * Everything this business's merchant may see about their money.
 *
 * Store-scoped by construction: the provider reads the connected account id
 * from this store's own integration row, so there is no account id for a
 * caller to supply or substitute.
 */
export async function financialsForStore(
  storeId: string,
  options?: { since?: Date; payoutLimit?: number },
): Promise<FinancialsResult> {
  ensureRegistered();

  // The rails a business could have money at, in the order they are asked.
  // Only providers with a registered implementation can answer at all.
  const integrations = await prisma.storeIntegration.findMany({
    where: { storeId, provider: { in: ["STRIPE", "PAYPAL"] }, status: "CONNECTED" },
    select: { provider: true },
  });

  for (const { provider } of integrations) {
    const implementation = financialsProviderFor(provider);
    if (implementation) return implementation.financialsFor(storeId, options);
  }

  // ============ NOT CONNECTED AND UNSUPPORTED ARE DIFFERENT ==========
  //
  // A business with PayPal connected and no Stripe has a real payment rail and
  // real money; Genesis simply cannot read a PayPal payout today. Saying "not
  // connected" would be false, and an empty balance would read as zero.
  if (integrations.length > 0) {
    return {
      available: false,
      reason: "unsupported",
      detail:
        `This business takes payments through ${integrations.map((i) => i.provider).join(", ")}, ` +
        "and Genesis cannot read payout information from there yet.",
    };
  }

  return {
    available: false,
    reason: "not_connected",
    detail: "No payment provider is connected to this business.",
  };
}

export { registerFinancialsProvider, financialsProviderFor } from "./provider";
export type { FinancialsProvider } from "./provider";
export * from "./types";
