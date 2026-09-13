import { prisma } from "@/lib/prisma";
import { PERMISSIONS, requireBusinessPageOrActive } from "@/lib/permissions";
import { LEGACY_BUSINESS_BASE } from "@/lib/dashboard/navConfig";
import { manageBilling, subscribeToPlan } from "./actions";
import { SubmitButton } from "../SubmitButton";
import { billingReturnNotice } from "@/lib/billing/returnNotice";

// Chapter 5 (Payments) — the owner's own account/subscription surface.
// Deliberately thin: real plan status + a real Stripe Billing Portal
// link covers payment method/invoice/cancellation management, no custom
// UI cloning what Stripe's own hosted portal already does well. Growth
// Points stays the "invest" surface (app/dashboard/growth-points/page.tsx,
// its own real "Buy more Growth Points" packages); this is the mechanical
// account-management surface — two different concerns, not merged into
// one page, matching Sean's "shouldn't feel separate" instruction without
// forcing them into the same UI.

function NotAvailable({ reason }: { reason: string }) {
  return (
    <div className="rounded-xl border border-dashed border-black/[.12] bg-zinc-50 p-5 text-sm text-zinc-500 dark:border-white/[.12] dark:bg-zinc-900/50 dark:text-zinc-400">
      Not available yet — {reason}
    </div>
  );
}

function formatDate(date: Date): string {
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// MIGRATED to explicit business context (2026-08-20, BUSINESS_CONTEXT.md Phase
// C). The screen is unchanged; what changed is where it gets its business.
//
// A `slug` means it was reached at /b/[slug] and that business is
// authoritative. No slug means the legacy /dashboard route. `basePath` is what
// every link inside uses, so a page rendered for one business never links into
// another.
//
// Billing is one of the four screens where operating on the wrong business costs
// real money — a subscription is charged against the business it is started from.
export async function BillingScreen({
  slug,
  basePath: _basePath,
  searchParams,
}: {
  slug?: string;
  basePath: string;
  /** Stripe's own return parameters. Optional: the legacy route passes none. */
  searchParams?: Promise<{ subscribe?: string }>;
}) {
  const { store } = await requireBusinessPageOrActive(PERMISSIONS.BILLING_MANAGE, slug);

  const [currentPlan, availablePlans] = await Promise.all([
    store.planId ? prisma.plan.findUnique({ where: { id: store.planId } }) : Promise.resolve(null),
    prisma.plan.findMany({ where: { stripePriceId: { not: null } }, orderBy: { name: "asc" } }),
  ]);

  // ============ THE RETURN FROM STRIPE, SAID TRUTHFULLY (2026-09-13) ====
  //
  // These four parameters have been written by lib/billing's redirects since
  // Chapter 5 and read by nothing, so an owner who had just paid was returned
  // to a page that said nothing about it at all.
  //
  // THE REDIRECT IS NOT THE AUTHORITY AND THIS DOES NOT TREAT IT AS ONE. The
  // only input that can turn a success redirect into a confirmation is the
  // Store row the webhook writes, computed here and passed in — never the
  // parameter. A success redirect arriving before the webhook says exactly
  // that, and the Current plan block above stays the authority either way.
  //
  // No polling, no delay, no retry: this route reads cookies() and
  // searchParams, so it renders per request, and returning from Stripe is a
  // full navigation. The row is re-read on arrival because it always was.
  const { subscribe } = (await searchParams) ?? {};
  const subscriptionConfirmed = Boolean(currentPlan) && store.subscriptionStatus === "active";
  const returnNotice = billingReturnNotice({ subscribe, subscriptionConfirmed });

  return (
    <div className="min-h-screen p-8 lg:min-h-0">
      <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">Billing</h1>
      <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
        How {store.name}&rsquo;s own account with Genesis is set up — your subscription and payment method.
        Growth Points, and investing in specific work, live on their own page.
      </p>

      {returnNotice && (
        /* Above the plan and deliberately quiet — it reports an arrival, and
           the block below it reports the state. A banner that shouted would be
           making the claim this notice exists to avoid making. */
        <div
          data-testid="billing-return-notice"
          data-tone={returnNotice.tone}
          className={`mt-6 rounded-xl border p-4 ${
            returnNotice.tone === "confirmed"
              ? "border-emerald-600/30 bg-emerald-50 dark:border-emerald-400/25 dark:bg-emerald-950/30"
              : "border-black/[.08] bg-zinc-50 dark:border-white/[.1] dark:bg-zinc-900/50"
          }`}
        >
          <p className="text-sm font-medium text-black dark:text-zinc-50">{returnNotice.title}</p>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{returnNotice.detail}</p>
        </div>
      )}

      <h2 className="mt-10 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        Current plan
      </h2>
      <div className="mt-3 rounded-xl border border-black/[.08] bg-white p-5 dark:border-white/[.1] dark:bg-zinc-950">
        {currentPlan ? (
          <>
            <p className="text-lg font-semibold text-black dark:text-zinc-50">{currentPlan.name}</p>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              Status: {store.subscriptionStatus ?? "unknown"}
              {store.subscriptionCurrentPeriodEnd &&
                ` — renews ${formatDate(store.subscriptionCurrentPeriodEnd)}`}
            </p>
          </>
        ) : (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {store.name}
            {" "}
            isn&rsquo;t on a plan yet.
          </p>
        )}
      </div>

      {store.businessPartnerTrialEndsAt && store.businessPartnerTrialEndsAt > new Date() && (
        <div className="mt-3 rounded-xl border border-black/[.08] bg-white p-5 dark:border-white/[.1] dark:bg-zinc-950">
          <p className="text-sm font-medium text-black dark:text-zinc-50">Business Partner Preview active</p>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Unlimited everyday improvements through {formatDate(store.businessPartnerTrialEndsAt)} — no need to
            think about spending a point on routine work this week.
          </p>
        </div>
      )}

      {!currentPlan && (
        <>
          <h2 className="mt-10 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Subscribe
          </h2>
          <div className="mt-3">
            {availablePlans.length === 0 ? (
              <NotAvailable reason="no plans are available to subscribe to yet." />
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {availablePlans.map((plan) => (
                  <form key={plan.id} action={subscribeToPlan.bind(null, slug, plan.id)}>
                    <div className="flex flex-col justify-between rounded-xl border border-black/[.08] bg-white p-5 dark:border-white/[.1] dark:bg-zinc-950">
                      <div>
                        <p className="text-sm font-medium text-black dark:text-zinc-50">{plan.name}</p>
                        {plan.monthlyGrowthPointAllowance !== null && (
                          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                            +{plan.monthlyGrowthPointAllowance} Growth Points every month
                          </p>
                        )}
                      </div>
                      <SubmitButton
                        pendingText="Starting..."
                        className="mt-4 rounded-full bg-foreground px-4 py-2 text-sm text-background transition-colors hover:bg-[#383838] dark:hover:bg-[#ccc]"
                      >
                        Subscribe
                      </SubmitButton>
                    </div>
                  </form>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      <h2 className="mt-10 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        Payment method &amp; invoices
      </h2>
      <div className="mt-3">
        {store.stripeCustomerId ? (
          <form action={manageBilling.bind(null, slug)}>
            <SubmitButton
              pendingText="Opening..."
              className="rounded-full border border-black/[.08] px-4 py-2 text-sm text-black transition-colors hover:bg-black/[.03] dark:border-white/[.145] dark:text-zinc-50 dark:hover:bg-white/[.05]"
            >
              Manage billing
            </SubmitButton>
          </form>
        ) : (
          <NotAvailable reason="nothing to manage yet — this appears once you've subscribed or bought Growth Points." />
        )}
      </div>
    </div>
  );
}


// The legacy route — same screen, business resolved from the account.
export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ subscribe?: string }>;
}) {
  // The legacy route is a real return target too — billingReturnUrl sends an
  // owner here whenever they acted without a business in the URL.
  return BillingScreen({ basePath: LEGACY_BUSINESS_BASE, searchParams });
}
