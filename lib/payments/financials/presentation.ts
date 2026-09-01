import type { BalanceAmount, MerchantFinancials, PayoutDestination, PayoutRecord, PayoutSchedule } from "./types";

// TURNING PROVIDER FACTS INTO SENTENCES A MERCHANT CAN ACT ON.
//
// ============ PURE, AND SEPARATE FROM THE SCREEN (2026-09-01) ==========
//
// The screen itself is a server component that calls Stripe, so the only way
// to see it render the healthy case is with a live connected account — which
// is E20 and stays external. Every JUDGEMENT the screen makes lives here
// instead, where it can be exercised exhaustively against the provider double
// without pretending a double is live evidence.
//
// So this file holds the wording and the decisions; the component holds the
// layout. If a sentence in here is wrong, a test says so.

/** Money the way a merchant reads it, per currency, because providers report per currency. */
export function formatAmount(amount: BalanceAmount): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: amount.currency }).format(
    amount.amountInCents / 100,
  );
}

/**
 * A list of per-currency amounts, or the honest absence.
 *
 * An empty array is a real answer from the provider and means zero across the
 * board — different from `instantAvailable` being null, which means the
 * provider said nothing at all.
 */
export function formatAmounts(amounts: BalanceAmount[], currencyFallback: string | null): string {
  if (amounts.length === 0) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currencyFallback ?? "USD",
    }).format(0);
  }
  return amounts.map(formatAmount).join(" · ");
}

/**
 * What to say about the next payout.
 *
 * ============ NEVER A CALCULATED DATE ==============================
 *
 * Sean: "Never calculate or invent a 'next payout' date. If Stripe has an
 * actual pending payout with an arrival date, show that; otherwise say that no
 * payout is currently scheduled/available from Stripe."
 *
 * Stripe exposes no next-payout field — verified against the installed SDK, not
 * assumed — so there are exactly two truthful answers and this returns one of
 * them. A date derived from the schedule would read as a promise, and would be
 * wrong every bank holiday.
 */
export function nextPayoutSentence(financials: Pick<MerchantFinancials, "nextPayout">): string {
  const next = financials.nextPayout;
  if (!next) {
    return "Stripe has no payout on the way right now.";
  }
  const when = next.arrivalDate.toLocaleDateString(undefined, {
    weekday: "long", month: "long", day: "numeric",
  });
  // "Expected", not "will arrive". An arrival date is the provider's estimate
  // and banks move it.
  return `${formatAmount({ currency: next.currency, amountInCents: next.amountInCents })} expected ${when}.`;
}

/** The schedule in a sentence, or an honest absence. */
export function scheduleSentence(schedule: PayoutSchedule | null): string {
  if (!schedule) return "Stripe has not told us your payout schedule.";
  if (schedule.interval === "manual") {
    return "Payouts are manual — Stripe holds your balance until you ask for it.";
  }
  const delay =
    schedule.delayDays === null
      ? ""
      : ` Funds are held ${schedule.delayDays} day${schedule.delayDays === 1 ? "" : "s"} before they go.`;
  if (schedule.interval === "weekly" && schedule.weeklyAnchor) {
    return `Paid out weekly, on ${schedule.weeklyAnchor}.${delay}`;
  }
  if (schedule.interval === "monthly" && schedule.monthlyAnchor) {
    return `Paid out monthly, on day ${schedule.monthlyAnchor}.${delay}`;
  }
  return `Paid out ${schedule.interval}.${delay}`;
}

/** The destination, masked, or the honest absence. */
export function destinationLabel(destination: PayoutDestination | null): string {
  if (!destination) return "Stripe did not say where this went.";
  const bank = destination.bankName ?? "Bank account";
  // Only ever four digits. See the mapper — routing numbers and holder names
  // are never carried this far.
  return destination.last4 ? `${bank} ending ${destination.last4}` : bank;
}

/**
 * Whether a payout landed, is moving, or went wrong.
 *
 * Stripe's own word is shown beside this, never replaced by it — a merchant
 * reading Genesis next to their Stripe dashboard must see the same vocabulary.
 * This only decides how it is EMPHASISED.
 */
export type PayoutTone = "settled" | "moving" | "failed";

export function toneFor(status: string): PayoutTone {
  if (status === "paid") return "settled";
  if (status === "failed" || status === "canceled") return "failed";
  return "moving";
}

/** What a failed payout means, in the provider's words plus ours. */
export function failureSentence(payout: PayoutRecord): string | null {
  if (toneFor(payout.status) !== "failed") return null;
  const reason = payout.failureMessage ?? payout.failureCode;
  return reason
    ? `Stripe says: ${reason}`
    : "Stripe did not say why. Your Stripe dashboard will have the detail.";
}

/**
 * The sentence that keeps the three kinds of money apart.
 *
 * Sean: "Keep payment/customer money, Stripe fees, and actual payouts visibly
 * distinct." This is that distinction written down, shown above the balances,
 * because a merchant who reads an available balance as "money I have" will plan
 * around funds sitting at Stripe.
 */
export const MONEY_DISTINCTION =
  "What a customer paid is not what Stripe holds, and what Stripe holds is not what has reached your bank.";

/** What to say when there is nothing to show, and why. */
export function unavailableSentence(reason: "not_connected" | "provider_error" | "unsupported", detail: string): string {
  switch (reason) {
    case "not_connected":
      return "No payment provider is connected to this business yet, so there is nothing to show.";
    case "unsupported":
      // Named rather than blanked: this business has real money somewhere
      // Genesis cannot read, and an empty screen would read as zero.
      return detail;
    case "provider_error":
      return `Stripe could not be reached just now, so these figures are missing rather than zero. ${detail}`;
  }
}
