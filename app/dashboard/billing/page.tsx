import { prisma } from "@/lib/prisma";
import { PERMISSIONS, requireStorePageAccess } from "@/lib/permissions";
import { manageBilling, subscribeToPlan } from "./actions";
import { SubmitButton } from "../SubmitButton";

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

export default async function BillingPage() {
  const { store } = await requireStorePageAccess(PERMISSIONS.BILLING_MANAGE);

  const [currentPlan, availablePlans] = await Promise.all([
    store.planId ? prisma.plan.findUnique({ where: { id: store.planId } }) : Promise.resolve(null),
    prisma.plan.findMany({ where: { stripePriceId: { not: null } }, orderBy: { name: "asc" } }),
  ]);

  return (
    <div className="min-h-screen p-8 lg:min-h-0">
      <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">Billing</h1>
      <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
        How {store.name}&rsquo;s own account with Genesis is set up — your subscription and payment method.
        Growth Points, and investing in specific work, live on their own page.
      </p>

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
                  <form key={plan.id} action={subscribeToPlan.bind(null, plan.id)}>
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
          <form action={manageBilling}>
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
