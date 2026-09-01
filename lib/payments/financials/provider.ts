import type { IntegrationProvider } from "@prisma/client";
import type { FinancialsResult } from "./types";

// ONE SHAPE, WHICHEVER PROVIDER HOLDS THE MONEY.
//
// ============ WHY THIS IS NOT A STRIPE MODULE (2026-09-01) =============
//
// Sean: "Use the existing Connections architecture and provider interfaces
// rather than creating a Stripe-specific parallel system."
//
// Stripe is the only implementation today and PayPal is already a payment rail
// in this codebase, so a `lib/stripe/payouts.ts` would be a second place that
// answers "what is this merchant owed" — and the first thing to depend on it
// would hard-code Stripe's own field names into a screen. The interface is the
// thing that keeps the surface honest when a second rail arrives.
//
// ============ DECLARED, NOT IMPLIED ===================================
//
// A connector opts in by having an entry here. Absence is a real answer:
// PayPal moves money and Genesis cannot currently read a PayPal payout, and
// reporting that as "unsupported" is the truth rather than an empty balance
// that reads as zero.
//
// This mirrors how IntegrationConnector already declares `capabilities`
// instead of the platform inferring them.

export interface FinancialsProvider {
  provider: IntegrationProvider;
  /**
   * Everything the merchant may see about their money at this provider.
   *
   * NEVER THROWS. A provider being unreachable is an ordinary condition and
   * this is read on a page — a thrown error would take the whole screen down
   * to report that one panel could not load. Failure is a value.
   */
  financialsFor(storeId: string, options?: { since?: Date; payoutLimit?: number }): Promise<FinancialsResult>;
}

const PROVIDERS = new Map<IntegrationProvider, FinancialsProvider>();

export function registerFinancialsProvider(provider: FinancialsProvider): void {
  PROVIDERS.set(provider.provider, provider);
}

export function financialsProviderFor(provider: IntegrationProvider): FinancialsProvider | null {
  return PROVIDERS.get(provider) ?? null;
}

/** Which providers can answer at all — for a surface that must not offer a dead panel. */
export function providersWithFinancials(): IntegrationProvider[] {
  return [...PROVIDERS.keys()];
}
