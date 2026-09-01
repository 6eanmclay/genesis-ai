import type Stripe from "stripe";
import { prisma } from "@/lib/prisma";
import type { FinancialsProvider } from "./provider";
import type {
  BalanceAmount, BalanceSnapshot, ConnectedAccountIdentity, FeeSummary,
  FinancialsResult, PayoutDestination, PayoutRecord, PayoutSchedule,
} from "./types";

// READING A MERCHANT'S MONEY OUT OF STRIPE, ON THEIR OWN ACCOUNT.
//
// ============ WHAT THE CONNECTION ACTUALLY PERMITS (2026-09-01) ========
//
// Genesis holds a Stripe Connect STANDARD authorization: the OAuth handoff in
// lib/integrations/stripe.ts stores `token.stripe_user_id` as
// externalAccountId, with `scope: "read_write"`. Every call below is made with
// the PLATFORM key and `{ stripeAccount }`, which is how Stripe scopes a
// request to a connected account.
//
// The scope is not a guess and not a choice made here — it is what checkout
// already needs. The connector's own note explains why read_only would break
// the thing that earns the money.
//
// ============ AND WHAT IT DOES NOT ====================================
//
// Verified by reading the installed SDK's type definitions rather than from
// memory, because "Stripe surely exposes that" is exactly the assumption Sean
// asked me not to make:
//
//   NO next-payout field exists. Nothing in stripe@22 declares one. What
//   exists is a payout already created and not yet arrived, which carries a
//   real arrival_date. Anything else would be a projection dressed as a fact.
//
//   instant_available is OPTIONAL. An account with no eligible balance, or in
//   a country where it does not apply, simply has no such key — which is a
//   different fact from zero and is carried as null.
//
//   Fees are on BALANCE TRANSACTIONS, not on payouts. A Payout has no fee
//   breakdown; the fee for a charge lives on its balance transaction.
//
// ============ AND WHAT IS DELIBERATELY LEFT BEHIND ====================
//
// Stripe returns `routing_number` on a bank account. It is not read, not
// mapped, and not stored. The merchant knows their own bank details and
// Genesis has no reason to hold them — the destination is a name and four
// digits, which answers "which account" and nothing else.

/** The narrow slice of Stripe this module uses, so a double can stand in for it. */
export interface StripeFinancialsClient {
  accounts: { retrieve(id: string): Promise<Stripe.Account> };
  balance: { retrieve(params: undefined, opts: { stripeAccount: string }): Promise<Stripe.Balance> };
  payouts: {
    list(
      params: { limit: number },
      opts: { stripeAccount: string },
    ): Promise<{ data: Stripe.Payout[] }>;
  };
  balanceTransactions: {
    list(
      params: { limit: number; created: { gte: number } },
      opts: { stripeAccount: string },
    ): Promise<{ data: Stripe.BalanceTransaction[] }>;
  };
}

const DEFAULT_PAYOUT_LIMIT = 20;
const FEE_WINDOW_DAYS = 30;
/** Bounded: a busy account has thousands, and this is a page, not a report. */
const FEE_TRANSACTION_LIMIT = 100;

function amounts(list: { currency: string; amount: number }[]): BalanceAmount[] {
  return list.map((a) => ({ currency: a.currency.toUpperCase(), amountInCents: a.amount }));
}

/**
 * A payout destination, reduced to what identifies it and nothing more.
 *
 * Stripe may return the destination as a bare id string rather than an
 * expanded object, and that is not an error — it means nothing was expanded.
 * A null destination is honest; inventing "Bank account" would not be.
 */
export function maskDestination(destination: Stripe.Payout["destination"]): PayoutDestination | null {
  if (!destination || typeof destination === "string") return null;
  const account = destination as Partial<Stripe.BankAccount> & { object?: string; brand?: string };
  return {
    kind: account.object ?? "unknown",
    bankName: account.bank_name ?? account.brand ?? null,
    // The ONLY digits that leave this function.
    last4: account.last4 ?? null,
    currency: account.currency ? account.currency.toUpperCase() : null,
  };
}

export function toPayoutRecord(payout: Stripe.Payout): PayoutRecord {
  return {
    id: payout.id,
    amountInCents: payout.amount,
    currency: payout.currency.toUpperCase(),
    // Verbatim. A merchant reading this beside their Stripe dashboard must see
    // the same word, so nothing is re-spelled into a Genesis vocabulary.
    status: payout.status,
    arrivalDate: new Date(payout.arrival_date * 1000),
    createdAt: new Date(payout.created * 1000),
    method: payout.method,
    automatic: payout.automatic,
    destination: maskDestination(payout.destination),
    failureCode: payout.failure_code ?? null,
    failureMessage: payout.failure_message ?? null,
    statementDescriptor: payout.statement_descriptor ?? null,
  };
}

export function toSchedule(account: Stripe.Account): PayoutSchedule | null {
  const schedule = account.settings?.payouts?.schedule;
  if (!schedule) return null;
  return {
    interval: schedule.interval,
    delayDays: typeof schedule.delay_days === "number" ? schedule.delay_days : null,
    weeklyAnchor: schedule.weekly_anchor ?? null,
    monthlyAnchor: schedule.monthly_anchor ?? null,
  };
}

export function toIdentity(account: Stripe.Account): ConnectedAccountIdentity {
  return {
    externalAccountId: account.id,
    email: account.email ?? null,
    // The provider's own name for the business, which is NOT Genesis's
    // Store.name — a merchant who renamed their shop in Genesis should still
    // recognise the account this is talking about.
    businessName: account.business_profile?.name ?? account.settings?.dashboard?.display_name ?? null,
    country: account.country ?? null,
    defaultCurrency: account.default_currency ? account.default_currency.toUpperCase() : null,
    chargesEnabled: account.charges_enabled === true,
    // A DIFFERENT QUESTION from chargesEnabled, and the one that matters here:
    // an account can take money and be unable to receive it.
    payoutsEnabled: account.payouts_enabled === true,
  };
}

export function toBalance(balance: Stripe.Balance): BalanceSnapshot {
  return {
    available: amounts(balance.available),
    pending: amounts(balance.pending),
    // Absent is not zero — see the type's own comment.
    instantAvailable: balance.instant_available ? amounts(balance.instant_available) : null,
  };
}

/**
 * The first payout that has not arrived yet.
 *
 * Stripe has no next-payout field, so this is the real in-flight one or
 * nothing. Never derived from the schedule.
 */
export function firstUnarrived(payouts: PayoutRecord[]): PayoutRecord | null {
  const inFlight = payouts.filter((p) => p.status === "pending" || p.status === "in_transit");
  if (inFlight.length === 0) return null;
  return inFlight.reduce((soonest, p) => (p.arrivalDate < soonest.arrivalDate ? p : soonest));
}

export function summariseFees(
  transactions: Stripe.BalanceTransaction[],
  since: Date,
): FeeSummary | null {
  // Charges only. A payout's own balance transaction is money LEAVING, and
  // including it would net the merchant's income against their own withdrawal.
  const charges = transactions.filter((t) => t.type === "charge" || t.type === "payment");
  if (charges.length === 0) return null;
  return {
    currency: charges[0].currency.toUpperCase(),
    feesInCents: charges.reduce((n, t) => n + t.fee, 0),
    grossInCents: charges.reduce((n, t) => n + t.amount, 0),
    netInCents: charges.reduce((n, t) => n + t.net, 0),
    since,
    transactionCount: charges.length,
  };
}

export function makeStripeFinancialsProvider(
  clientFor: () => StripeFinancialsClient,
): FinancialsProvider {
  return {
    provider: "STRIPE",
    async financialsFor(storeId, options): Promise<FinancialsResult> {
      // TENANT-SCOPED AT THE SOURCE. The connected account id is read from THIS
      // store's own integration row; there is no caller-supplied account id to
      // substitute, so one merchant's balance cannot be fetched from another's
      // page however the call is made.
      const integration = await prisma.storeIntegration.findUnique({
        where: { storeId_provider: { storeId, provider: "STRIPE" } },
        select: { externalAccountId: true, status: true },
      });
      if (!integration?.externalAccountId) {
        return { available: false, reason: "not_connected", detail: "No Stripe account is connected to this business." };
      }

      const stripeAccount = integration.externalAccountId;
      const since = options?.since ?? new Date(Date.now() - FEE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
      const limit = options?.payoutLimit ?? DEFAULT_PAYOUT_LIMIT;

      try {
        const client = clientFor();
        const [account, balance, payoutList, transactionList] = await Promise.all([
          client.accounts.retrieve(stripeAccount),
          client.balance.retrieve(undefined, { stripeAccount }),
          client.payouts.list({ limit }, { stripeAccount }),
          client.balanceTransactions.list(
            { limit: FEE_TRANSACTION_LIMIT, created: { gte: Math.floor(since.getTime() / 1000) } },
            { stripeAccount },
          ),
        ]);

        const payouts = payoutList.data.map(toPayoutRecord);
        return {
          available: true,
          provider: "STRIPE",
          identity: toIdentity(account),
          balance: toBalance(balance),
          schedule: toSchedule(account),
          payouts,
          nextPayout: firstUnarrived(payouts),
          fees: summariseFees(transactionList.data, since),
        };
      } catch (error) {
        // NEVER THROWN ONWARD. This is read on a page, and one panel failing
        // must not take the screen with it. The provider's own wording is
        // carried so a merchant can act on it rather than seeing "error".
        return {
          available: false,
          reason: "provider_error",
          detail: error instanceof Error ? error.message : "Stripe could not be reached.",
        };
      }
    },
  };
}
