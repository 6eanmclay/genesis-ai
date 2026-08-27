import { prisma } from "@/lib/prisma";
import {
  PAYMENT_PROVIDER_PREFERENCE,
  chooseProvider,
  type PaymentProviderChoice,
} from "./providers";

// The one place checkout-provider policy lives. Adding a new provider later
// (Square, Authorize.net, ...) means adding a case here, not re-touching
// createCheckoutSession every time.
//
// No platform-wide fallback exists — payment routing is explicit and
// deterministic by design. A store with nothing connected is a real
// misconfiguration, not something to paper over with a shared account; the
// caller must have already gated on canStoreAcceptPayments, and
// publishStoreExecutable independently refuses to publish an unconnected
// store, so reaching a throw here means both checks were bypassed.
//
// THE TYPE, THE LABELS AND chooseProvider LIVE IN ./providers.ts because
// client components need them and this file imports prisma. Re-exported below
// so server callers still have one import.
//
// ============ WHY PAYPAL WAS INVISIBLE (2026-08-27) =======================
//
// This file said "prefer Stripe, then PayPal", and that sentence was the bug.
// It reads as a sensible default and is actually a rule that PayPal can never
// win: a store with BOTH connected always got Stripe, so a merchant who had
// gone to the trouble of connecting PayPal had a rail that no customer could
// ever reach. Nothing failed, nothing logged, and the Connections screen said
// PayPal was connected — because it was.
//
// The mistake was treating "which provider" as a STORE-LEVEL FACT when it is a
// CUSTOMER-LEVEL CHOICE. Preference only makes sense as a default for when the
// customer has not expressed one; it was standing in for the choice itself.

export { PAYMENT_PROVIDER_LABELS, chooseProvider } from "./providers";
export type { PaymentProviderChoice } from "./providers";

/**
 * Every provider this store can actually charge through, in preference order.
 *
 * THE STOREFRONT RENDERS FROM THIS, so a provider that is connected is a
 * provider the customer can pick — the two cannot drift apart, because there
 * is no second list.
 */
export async function availableProviders(storeId: string): Promise<PaymentProviderChoice[]> {
  const connected = await prisma.storeIntegration.findMany({
    where: { storeId, provider: { in: ["STRIPE", "PAYPAL"] }, status: "CONNECTED" },
    select: { provider: true },
  });
  const found = new Set(connected.map((i) => i.provider));
  return PAYMENT_PROVIDER_PREFERENCE.filter((provider) => found.has(provider));
}

/** The provider to charge through, given what the customer asked for. */
export async function resolveProvider(
  storeId: string,
  requested?: string | null,
): Promise<PaymentProviderChoice> {
  const available = await availableProviders(storeId);
  if (available.length === 0) {
    throw new Error(`Store ${storeId} has no connected payment provider — cannot select a checkout provider.`);
  }
  return chooseProvider(available, requested);
}

/**
 * The default provider, for paths where the customer was never asked.
 *
 * Unchanged behaviour, deliberately: it is still "the first connected one in
 * preference order". What changed is that it is no longer the ONLY answer.
 */
export async function selectProvider(storeId: string): Promise<PaymentProviderChoice> {
  return resolveProvider(storeId, null);
}
