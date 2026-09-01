import type { Store } from "@prisma/client";
import { financialsForStore } from "@/lib/payments/financials";
import {
  MONEY_DISTINCTION, destinationLabel, failureSentence, formatAmount, formatAmounts,
  nextPayoutSentence, scheduleSentence, toneFor, unavailableSentence,
} from "@/lib/payments/financials/presentation";
import { DEFAULT_THEME, type Theme, themeCssVars } from "@/lib/theme";
import { STRIPE_MANAGEMENT_LINKS } from "@/lib/payments/financials/stripeLinks";

// WHAT STRIPE HOLDS, AND WHAT HAS REACHED THE BANK.
//
// ============ THREE KINDS OF MONEY, KEPT APART (2026-09-01) ============
//
// Sean: "Keep payment/customer money, Stripe fees, and actual payouts visibly
// distinct." They are days apart and a merchant who reads a balance as "money I
// have" will plan around funds sitting at Stripe.
//
//   what a customer paid   Orders. Genesis records it, and it is NOT here.
//   what Stripe holds      available and pending. Not in a bank account.
//   what Stripe took       fees, on the balance transactions.
//   what actually left     payouts, with the date the bank expects them.
//
// ============ AND NO WRITES, ANYWHERE =================================
//
// This screen reads. Changing a payout schedule, adding a bank account or
// triggering an instant payout are all things Stripe owns and does better, so
// the screen links out rather than reimplementing them. There is no Stripe
// write operation in this file or anything it calls.

interface FinancesProps {
  store: Store;
  /**
   * "/dashboard" or "/b/<slug>".
   *
   * Required rather than defaulted, matching OrderDetail: a default would let a
   * call site that was never updated keep producing legacy links silently,
   * which is the exact shape of bug that parameter exists to close.
   */
  basePath: string;
}

function Section({ title, subtitle, children }: {
  title: string; subtitle?: string; children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-black/[.08] p-5 dark:border-white/[.145]">
      <h2 className="text-sm font-semibold text-black dark:text-zinc-50">{title}</h2>
      {subtitle && <p className="mt-0.5 text-xs text-zinc-500">{subtitle}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-wrap justify-between gap-2 border-b border-black/[.04] py-1.5 last:border-0 dark:border-white/[.06]">
      <span className="text-xs text-zinc-500 dark:text-zinc-400">{label}</span>
      <span className="text-xs text-black dark:text-zinc-50">{value}</span>
    </div>
  );
}

const TONE_CLASS: Record<string, string> = {
  settled: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  moving: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  failed: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
};

export async function Finances({ store, basePath }: FinancesProps) {
  // Store-scoped by construction: financialsForStore reads the connected
  // account id from THIS store's own integration row, so there is no account
  // id for anything on this page to supply or substitute.
  const financials = await financialsForStore(store.id);
  const theme = (store.theme as Theme | null) ?? DEFAULT_THEME;

  if (!financials.available) {
    return (
      <div data-screen="finances" style={themeCssVars(theme)} className="min-h-screen p-8 lg:min-h-0">
        <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">Money</h1>
        <div className="mt-6 max-w-2xl rounded-xl border border-black/[.08] p-5 dark:border-white/[.145]">
          {/* Said in a sentence rather than shown as zeroes. An empty balance
              and an unreachable provider look identical in a number, and only
              one of them means the merchant has no money. */}
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            {unavailableSentence(financials.reason, financials.detail)}
          </p>
          {financials.reason === "not_connected" && (
            <a
              // Rebased, not hard-coded. This said "/dashboard/payments",
              // so a merchant on /b/<slug>/finances was thrown to the legacy
              // base — which resolves whichever business the ACCOUNT last made
              // active, not the one they were looking at. Caught by the suite.
              href={`${basePath}/payments`}
              className="mt-3 inline-block rounded-full bg-[#2563eb] px-3.5 py-1.5 text-xs font-medium text-white"
            >
              Connect a payment provider
            </a>
          )}
        </div>
      </div>
    );
  }

  const { identity, balance, schedule, payouts, fees } = financials;
  const currency = identity.defaultCurrency;

  return (
    <div data-screen="finances" style={themeCssVars(theme)} className="min-h-screen p-8 lg:min-h-0">
      <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">Money</h1>
      <p className="mt-1 max-w-2xl text-sm text-zinc-500">{MONEY_DISTINCTION}</p>

      <div className="mt-6 grid max-w-4xl grid-cols-1 gap-4 sm:grid-cols-2">
        <Section title="Your Stripe account">
          <Field label="Business" value={identity.businessName ?? <span className="text-zinc-400">Not set at Stripe</span>} />
          <Field label="Email" value={identity.email ?? <span className="text-zinc-400">Not set</span>} />
          <Field label="Country" value={identity.country ?? "—"} />
          <Field label="Account" value={<span className="font-mono text-[11px]">{identity.externalAccountId}</span>} />
          {/* TWO DIFFERENT PERMISSIONS. An account can take money and be unable
              to receive it, and the second is the one that stops a payout. */}
          <Field
            label="Can take payments"
            value={identity.chargesEnabled ? "Yes" : <span className="text-red-700 dark:text-red-400">No</span>}
          />
          <Field
            label="Can receive payouts"
            value={identity.payoutsEnabled ? "Yes" : <span className="text-red-700 dark:text-red-400">No</span>}
          />

          {/* ============ THE WAY OUT TO STRIPE (2026-09-01) ==========
              Directly beneath the identity, deliberately: a merchant about to
              change a bank account should be able to see WHICH account they
              are about to change first. Sean has more than one Stripe login,
              and the id above is how he tells them apart — the plain dashboard
              paths cannot do that for him, so the identity does.

              Not a login link. accounts.createLoginLink is Express-only, per
              the SDK's own doc comment, and Genesis connects Standard
              accounts — see lib/payments/financials/stripeLinks.ts. */}
          <div className="mt-3 border-t border-black/[.04] pt-3 dark:border-white/[.06]">
            <a
              href={STRIPE_MANAGEMENT_LINKS[0].url}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="manage-in-stripe"
              className="inline-block rounded-full bg-[#635bff] px-4 py-2 text-xs font-medium text-white transition-opacity hover:opacity-90"
            >
              Manage in Stripe ↗
            </a>
            <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
              Signed in to more than one Stripe account? Check it matches{" "}
              <span className="font-mono">{identity.externalAccountId}</span> above.
            </p>
            <ul className="mt-2 flex flex-col gap-1">
              {STRIPE_MANAGEMENT_LINKS.slice(1).map((link) => (
                <li key={link.url}>
                  <a
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-[#2563eb] underline"
                  >
                    {link.label} ↗
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </Section>

        <Section
          title="What Stripe is holding"
          subtitle="Not in your bank account yet."
        >
          <Field label="Available to pay out" value={<strong>{formatAmounts(balance.available, currency)}</strong>} />
          <Field label="Pending — not cleared yet" value={formatAmounts(balance.pending, currency)} />
          {/* NULL IS NOT ZERO. Stripe's instant_available is optional; an
              account where it does not apply has no such key, and reporting
              that as £0.00 would read as "you cannot", which is a claim. */}
          <Field
            label="Available instantly"
            value={
              balance.instantAvailable
                ? formatAmounts(balance.instantAvailable, currency)
                : <span className="text-zinc-400">Stripe did not report instant availability</span>
            }
          />
        </Section>

        <Section title="Next payout" subtitle="Only when Stripe has really started one.">
          <p className="text-sm text-black dark:text-zinc-50">{nextPayoutSentence(financials)}</p>
          <p className="mt-2 text-xs text-zinc-500">{scheduleSentence(schedule)}</p>
        </Section>

        <Section title="What Stripe took" subtitle="Fees on the payments themselves — not on payouts.">
          {fees ? (
            <>
              <Field label={`Payments (last 30 days, ${fees.transactionCount})`} value={formatAmount({ currency: fees.currency, amountInCents: fees.grossInCents })} />
              <Field label="Stripe fees" value={`− ${formatAmount({ currency: fees.currency, amountInCents: fees.feesInCents })}`} />
              <Field label="Reached your balance" value={<strong>{formatAmount({ currency: fees.currency, amountInCents: fees.netInCents })}</strong>} />
            </>
          ) : (
            <p className="text-xs text-zinc-500">No payments in the last 30 days, so there are no fees to show.</p>
          )}
        </Section>
      </div>

      <div className="mt-4 max-w-4xl">
        <Section title="Payouts" subtitle="Money that actually left Stripe for your bank.">
          {payouts.length === 0 ? (
            <p className="text-xs text-zinc-500">Stripe has not sent a payout yet.</p>
          ) : (
            <ul className="flex flex-col">
              {payouts.map((payout) => (
                <li
                  key={payout.id}
                  className="flex flex-wrap items-center justify-between gap-2 border-b border-black/[.04] py-2.5 last:border-0 dark:border-white/[.06]"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-black dark:text-zinc-50">
                      {formatAmount({ currency: payout.currency, amountInCents: payout.amountInCents })}
                    </p>
                    <p className="text-xs text-zinc-500">
                      {destinationLabel(payout.destination)} ·{" "}
                      {payout.method === "instant" ? "Instant" : "Standard"} ·{" "}
                      {payout.automatic ? "On your schedule" : "Requested"}
                    </p>
                    {failureSentence(payout) && (
                      <p className="mt-0.5 text-xs text-red-700 dark:text-red-400">{failureSentence(payout)}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-zinc-500">
                      {/* The bank's expected date, which is the number a
                          merchant is actually waiting on. */}
                      {payout.arrivalDate.toLocaleDateString()}
                    </span>
                    {/* Stripe's own word, never re-spelled. */}
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${TONE_CLASS[toneFor(payout.status)]}`}
                    >
                      {payout.status}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      {/* ============ WHAT STRIPE OWNS, STRIPE KEEPS =================
          Changing a schedule, adding a bank account or taking an instant
          payout all move real money and all have consequences Stripe explains
          better than a second copy of its forms would. Genesis shows the
          facts and hands over for the actions. */}
      {/* ============ MONEY AND PAYMENTS ARE NEIGHBOURS ==============
          Money is what HAPPENED to the money. Payments is whether the
          connection carrying it still works. Two questions, and somebody who
          finds a wrong answer here usually needs the other one next. */}
      <p className="mt-4 max-w-4xl text-xs text-zinc-500">
        Genesis never changes anything at Stripe. To check the connection itself,
        see{" "}
        <a href={`${basePath}/payments`} className="text-[#2563eb] underline">
          Payments
        </a>
        .
      </p>
    </div>
  );
}
