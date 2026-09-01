// WHAT A MERCHANT IS OWED, AND WHAT HAS ACTUALLY REACHED THEIR BANK.
//
// ============ THE DISTINCTION THIS FILE EXISTS TO PROTECT ==============
//
// Sean: "Genesis must clearly distinguish 'payment successfully processed'
// from 'funds successfully paid out.'" Those are different events, days apart,
// and conflating them is the single most expensive mistake this layer could
// make — a merchant who reads "you've been paid $69.80" and has not been paid
// will plan around money that is not there.
//
// So they are different types, not one number with a status:
//
//   BalanceSnapshot   money Stripe is holding for the merchant. `available`
//                     can be paid out; `pending` has not cleared yet. Neither
//                     is in a bank account.
//   PayoutRecord      money Stripe has SENT to the bank. `arrivalDate` is when
//                     the bank expects it, `status` is what actually happened.
//
// An Order is a third thing again — what a CUSTOMER paid, which Genesis
// already records. This layer never touches Order, and nothing here should be
// added to a revenue total: the connector's own notes explain why a second
// record of the same money would inflate the intelligence layer.
//
// ============ AND WHAT IS DELIBERATELY NOT MODELLED ====================
//
// No account numbers, no routing numbers, no bank credentials of any kind.
// Stripe DOES expose `routing_number` on an external account and this layer
// deliberately does not carry it — the merchant already knows their own bank
// details and Genesis has no reason to hold them. A destination is a bank name
// and four digits, which is exactly enough to answer "which account is this
// going to" and nothing more.

/** One currency's worth of a balance. Stripe reports per-currency, not a total. */
export interface BalanceAmount {
  currency: string;
  amountInCents: number;
}

export interface BalanceSnapshot {
  /** Cleared, and payable now. Not in a bank account. */
  available: BalanceAmount[];
  /** Taken from customers and not yet cleared. */
  pending: BalanceAmount[];
  /**
   * What could be paid out instantly, when the provider says.
   *
   * Null means the provider did not report it — which is a different fact from
   * "zero". Stripe's `instant_available` is an OPTIONAL field: an account with
   * no eligible instant-payout balance, or one in a country or on a schedule
   * where the feature does not apply, simply has no such key. Reporting that
   * as £0.00 available instantly would be inventing an answer.
   */
  instantAvailable: BalanceAmount[] | null;
}

/** Where a payout is going, masked to what a merchant needs to recognise it. */
export interface PayoutDestination {
  /** "bank_account" or "card", as the provider classifies it. */
  kind: string;
  /** The bank's name, when the provider gives one. */
  bankName: string | null;
  /** The last four digits. Never the full number, never the routing number. */
  last4: string | null;
  currency: string | null;
}

export interface PayoutRecord {
  id: string;
  amountInCents: number;
  currency: string;
  /**
   * The provider's own status, verbatim: paid, pending, in_transit, canceled,
   * failed. Never re-spelled into a Genesis vocabulary — a merchant reading
   * this beside their Stripe dashboard must see the same word.
   */
  status: string;
  /** When the bank is expected to have it. Not when it was sent. */
  arrivalDate: Date;
  createdAt: Date;
  /** "standard" or "instant". */
  method: string;
  /** True when the provider's schedule sent it, false when a person did. */
  automatic: boolean;
  destination: PayoutDestination | null;
  /** Present only on a failure, and shown as the provider worded it. */
  failureCode: string | null;
  failureMessage: string | null;
  /** The provider's own statement text, when set. */
  statementDescriptor: string | null;
}

export interface PayoutSchedule {
  /** daily, weekly, monthly, or manual. */
  interval: string;
  /** How many days the provider holds funds before paying out. */
  delayDays: number | null;
  /** For weekly: which day. For monthly: which date. Null otherwise. */
  weeklyAnchor: string | null;
  monthlyAnchor: number | null;
}

/** Who the connected account is, as the provider describes it. */
export interface ConnectedAccountIdentity {
  /** The provider's own id for the account. */
  externalAccountId: string;
  /** The account's email at the provider, when exposed. */
  email: string | null;
  /** The business name the provider holds — not Genesis's Store.name. */
  businessName: string | null;
  country: string | null;
  defaultCurrency: string | null;
  /** Whether the account can currently take money. */
  chargesEnabled: boolean;
  /** Whether the account can currently RECEIVE money. A different question. */
  payoutsEnabled: boolean;
}

export interface MerchantFinancials {
  provider: string;
  identity: ConnectedAccountIdentity;
  balance: BalanceSnapshot;
  schedule: PayoutSchedule | null;
  /** Most recent first. */
  payouts: PayoutRecord[];
  /**
   * The next payout, when one is genuinely known.
   *
   * ============ THERE IS NO "NEXT PAYOUT" FIELD =====================
   *
   * Checked against the installed SDK rather than assumed: nothing in Stripe's
   * type definitions exposes a next-payout date. What exists is a payout that
   * has been created and not yet arrived, which carries a real arrivalDate.
   *
   * So this is that payout when one is in flight, and NULL otherwise —
   * never a date computed from the schedule. A projected date derived from
   * `interval` and `delayDays` would look identical to a fact and would be a
   * guess about somebody's money, and would be wrong every bank holiday.
   */
  nextPayout: PayoutRecord | null;
  /**
   * Provider fees over the window that was asked for.
   *
   * From the provider's balance transactions, which is where fees actually
   * live — a Payout carries no fee breakdown of its own.
   */
  fees: FeeSummary | null;
}

export interface FeeSummary {
  currency: string;
  /** Total provider fees over the window. */
  feesInCents: number;
  /** Gross taken from customers over the window. */
  grossInCents: number;
  /** Gross minus fees. What actually reached the balance. */
  netInCents: number;
  since: Date;
  /** How many transactions this was computed from, so a small sample is legible. */
  transactionCount: number;
}

/** What a provider could not answer, and why. Never silently omitted. */
export interface FinancialsUnavailable {
  available: false;
  /** connected | not_connected | provider_error | unsupported */
  reason: "not_connected" | "provider_error" | "unsupported";
  detail: string;
}

export type FinancialsResult = ({ available: true } & MerchantFinancials) | FinancialsUnavailable;
