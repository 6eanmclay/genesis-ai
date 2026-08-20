import Link from "next/link";
import { PERMISSIONS, requireBusinessPageOrActive } from "@/lib/permissions";
import { LEGACY_BUSINESS_BASE } from "@/lib/dashboard/navConfig";
import { getGrowthPointHistory, getGrowthPointUsageByAction, getReferralsSent } from "@/lib/growthPoints/ownerQueries";
import { getOrCreateReferralCode } from "@/lib/growthPoints/referral";
import { growthPointPackages } from "@/lib/growthPoints/purchaseCatalog";
import { purchaseGrowthPoints, addGrowthPointsForTesting } from "./actions";
import { SubmitButton } from "../SubmitButton";
import { isPlatformAdmin } from "@/lib/platformAdmin";

// Growth Points Economy (Chapter 2) — the owner's own real economy view:
// current balance, real point history, real usage by action, their own
// referral code/status, and an honest "Buy More" entry point that says
// exactly what it is today — a real deferred stub, not a fake checkout.
// Reuses the established stat-tile-card + plain-list pattern from
// app/dashboard/analytics/page.tsx and app/admin/page.tsx (no charting
// library exists anywhere in this app) and admin/page.tsx's own
// NotAvailable component/copy convention for the honest gap.

const TYPE_LABEL: Record<string, string> = {
  DEDUCTION: "Invested",
  REFRESH: "Monthly refresh",
  REFERRAL_REWARD: "Referral reward",
  PURCHASE: "Purchase",
  ADJUSTMENT: "Adjustment",
};

function formatDate(date: Date): string {
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function Card({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-black/[.08] bg-white p-5 dark:border-white/[.1] dark:bg-zinc-950">
      <p className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</p>
      <p className="mt-1.5 text-2xl font-semibold tabular-nums text-black dark:text-zinc-50">{value}</p>
      {sub && <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{sub}</p>}
    </div>
  );
}

function NotAvailable({ reason }: { reason: string }) {
  return (
    <div className="rounded-xl border border-dashed border-black/[.12] bg-zinc-50 p-5 text-sm text-zinc-500 dark:border-white/[.12] dark:bg-zinc-900/50 dark:text-zinc-400">
      Not available yet — {reason}
    </div>
  );
}

// MIGRATED to explicit business context (2026-08-20, BUSINESS_CONTEXT.md Phase
// C). The screen is unchanged; what changed is where it gets its business.
//
// A `slug` means it was reached at /b/[slug] and that business is
// authoritative. No slug means the legacy /dashboard route. `basePath` is what
// every link inside uses, so a page rendered for one business never links into
// another.
//
// Growth Points are per business, and buying them is real money. Crediting the
// wrong balance is the failure this migration exists to make impossible.
export async function GrowthPointsScreen({
  slug,
  basePath,
}: {
  slug?: string;
  basePath: string;
}) {
  const { userId, store, role } = await requireBusinessPageOrActive(PERMISSIONS.ANALYTICS_VIEW, slug);
  const isOperator = await isPlatformAdmin();

  const [history, usage, referrals, referralCode] = await Promise.all([
    getGrowthPointHistory(store.id, 20),
    getGrowthPointUsageByAction(store.id),
    getReferralsSent(userId),
    getOrCreateReferralCode(userId),
  ]);

  const referralLink = `${process.env.NEXTAUTH_URL ?? ""}/signup?ref=${referralCode}`;
  const rewardedReferrals = referrals.filter((r) => r.status === "REWARDED").length;
  const packages = growthPointPackages();

  return (
    <div className="min-h-screen p-8 lg:min-h-0">
      <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">Growth Points</h1>
      <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
        An investment in {store.name}&rsquo;s growth, not a fee to use Genesis — thinking, planning, and asking
        questions are always free. Points are only ever invested when you choose to have Genesis execute real
        work on the business.
      </p>

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card label="Current balance" value={`${store.growthPointBalance}`} sub="Growth Points available" />
        <Card
          label="Total invested"
          value={`${usage.reduce((sum, u) => sum + u.totalSpent, 0)}`}
          sub={`across ${usage.reduce((sum, u) => sum + u.count, 0)} action${usage.reduce((sum, u) => sum + u.count, 0) === 1 ? "" : "s"}`}
        />
        <Card
          label="Referrals rewarded"
          value={`${rewardedReferrals}`}
          sub={`${referrals.length} invited total`}
        />
      </div>

      {/* Real, urgent unblock (2026-08-09) — "do not let Growth Points
          become a blocker that makes the product impossible to test"
          (Sean). Deliberately separate from, and visually distinct from,
          "Buy more Growth Points" below — this is a development/testing
          convenience, never disguised as a purchase or an earned reward.
          Every adjustment is fully visible in Point history below, labeled
          honestly.

          GATED 2026-08-20 — this is the "real product decision to gate/remove"
          the previous note here anticipated. It was rendered for any OWNER and
          the action was gated on BILLING_MANAGE, which every owner has on their
          own store, so a real customer could mint themselves 500 points per
          submit, unlimited times, on a product sold for money. Platform
          operators only now, on both sides: the server action refuses, and this
          does not render, so nobody is shown a button that throws. */}
      {isOperator && (
        <div className="mt-6 rounded-xl border border-dashed border-amber-400/40 bg-amber-50/50 p-5 dark:border-amber-400/25 dark:bg-amber-950/10">
          <p className="text-sm font-medium text-black dark:text-zinc-50">Add Growth Points — development/testing</p>
          <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
            A real, transparent balance adjustment (never a purchase or an earned reward) so testing J4 never
            gets blocked while you&rsquo;re still building. Shows up honestly in Point history below.
          </p>
          <form action={addGrowthPointsForTesting.bind(null, slug)} className="mt-3 flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-zinc-500 dark:text-zinc-400">Amount (max 500)</span>
              <input
                type="number"
                name="amount"
                min={1}
                max={500}
                step={1}
                defaultValue={100}
                required
                className="w-32 rounded-lg border border-black/[.08] px-3 py-1.5 text-sm dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
              />
            </label>
            <SubmitButton
              pendingText="Adding..."
              className="rounded-full bg-amber-500 px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              Add points
            </SubmitButton>
          </form>
        </div>
      )}

      <h2 className="mt-12 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        Usage by action
      </h2>
      <div className="mt-3 overflow-x-auto rounded-xl border border-black/[.08] dark:border-white/[.1]">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-black/[.08] text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-white/[.1] dark:text-zinc-400">
              <th className="px-4 py-2.5 font-medium">Action</th>
              <th className="px-4 py-2.5 text-right font-medium">Times invested in</th>
              <th className="px-4 py-2.5 text-right font-medium">Points invested</th>
            </tr>
          </thead>
          <tbody>
            {usage.map((u) => (
              <tr key={u.actionType} className="border-b border-black/[.06] last:border-0 dark:border-white/[.06]">
                <td className="px-4 py-2.5 text-black dark:text-zinc-50">{u.actionType}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-zinc-600 dark:text-zinc-300">{u.count}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-black dark:text-zinc-50">{u.totalSpent}</td>
              </tr>
            ))}
            {usage.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-6 text-center text-zinc-500 dark:text-zinc-400">
                  Nothing invested yet — every executed action will show up here.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <h2 className="mt-12 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        Point history
      </h2>
      {history.length === 0 ? (
        <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
          Nothing yet — refreshes, referral rewards, and executed actions will appear here.
        </p>
      ) : (
        <ul className="mt-3 flex flex-col divide-y divide-black/[.05] rounded-xl border border-black/[.08] dark:divide-white/[.08] dark:border-white/[.1]">
          {history.map((item) => (
            <li key={item.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <div>
                <p className="text-sm text-black dark:text-zinc-50">
                  {TYPE_LABEL[item.type] ?? item.type}
                  {item.actionType && <span className="text-zinc-500"> — {item.actionType}</span>}
                </p>
                <p className="mt-0.5 text-xs text-zinc-500">{item.description}</p>
              </div>
              <div className="shrink-0 text-right">
                <p className={`text-sm font-medium tabular-nums ${item.amount >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-black dark:text-zinc-50"}`}>
                  {item.amount >= 0 ? "+" : ""}
                  {item.amount}
                </p>
                <p className="mt-0.5 text-xs text-zinc-500">{formatDate(item.createdAt)}</p>
              </div>
            </li>
          ))}
        </ul>
      )}

      <h2 className="mt-12 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        Invite other owners
      </h2>
      <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">
        Share your link — when someone you invite finishes their first real conversation with J4, you both
        earn Growth Points.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-black/[.08] bg-zinc-50 px-4 py-3 text-sm dark:border-white/[.1] dark:bg-zinc-900/50">
        <code className="text-black dark:text-zinc-50">{referralLink}</code>
      </div>
      {referrals.length > 0 && (
        <ul className="mt-3 flex flex-col divide-y divide-black/[.05] rounded-xl border border-black/[.08] dark:divide-white/[.08] dark:border-white/[.1]">
          {referrals.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
              <span className="text-black dark:text-zinc-50">{r.referredName ?? r.referredEmail}</span>
              <span className={r.status === "REWARDED" ? "text-emerald-600 dark:text-emerald-400" : "text-zinc-500"}>
                {r.status === "REWARDED" ? "Rewarded" : "Pending"}
              </span>
            </li>
          ))}
        </ul>
      )}

      <h2 className="mt-12 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        Buy more Growth Points
      </h2>
      <div className="mt-3">
        {role !== "OWNER" ? (
          <NotAvailable reason="only the store owner can buy Growth Points." />
        ) : packages.length === 0 ? (
          <NotAvailable reason="no Growth Point packages are available to buy yet." />
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {packages.map(([key, pkg]) => (
              <form
                key={key}
                action={purchaseGrowthPoints.bind(null, slug, key)}
                className="flex flex-col justify-between rounded-xl border border-black/[.08] bg-white p-5 dark:border-white/[.1] dark:bg-zinc-950"
              >
                <div>
                  <p className="text-sm font-medium text-black dark:text-zinc-50">{pkg.label}</p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums text-black dark:text-zinc-50">
                    +{pkg.pointAmount}
                  </p>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">Growth Points</p>
                </div>
                <button
                  type="submit"
                  className="mt-4 rounded-full bg-foreground px-4 py-2 text-sm text-background transition-colors hover:bg-[#383838] dark:hover:bg-[#ccc]"
                >
                  Invest
                </button>
              </form>
            ))}
          </div>
        )}
        {role === "OWNER" && (
          <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
            Subscribing to a plan, and managing your payment method, live in{" "}
            <Link href={`${basePath}/billing`} className="underline decoration-current/30 hover:decoration-current">
              Billing
            </Link>
            .
          </p>
        )}
      </div>
    </div>
  );
}


// The legacy route — same screen, business resolved from the account.
export default async function GrowthPointsPage() {
  return GrowthPointsScreen({ basePath: LEGACY_BUSINESS_BASE });
}
