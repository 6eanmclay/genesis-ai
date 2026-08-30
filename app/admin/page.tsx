import Link from "next/link";
import {
  totalCostToday,
  totalCostThisMonth,
  costByFeature,
  costByBusinessIntent,
  averageCostPerVisitor,
  averageCostPerCustomer,
  averageCostPerCreatedBusiness,
  revenueVsAiCost,
} from "@/lib/admin/aiUsageQueries";

// AI Cost & Usage Infrastructure, Milestone 7 — the real dashboard, built
// directly on Milestone 5's already-verified query layer and Milestone 6's
// already-verified gate. Every number on this page is a real aggregate
// over AiUsageEvent, computed the same way whether Milestones 2-4's own
// checkpoint data or real future usage produced it — nothing here is
// mocked or seeded specifically for this page.
//
// Two metrics Sean explicitly asked for are honestly unavailable today,
// not faked: gross margin by subscription tier (no tier system exists —
// see lib/execution/genesisActions.ts's own flagged taxonomy note) and
// API cost vs. Growth Credits consumed (growthCreditValue is universally
// null until a real catalog exists, lib/growthCreditCatalog.ts). Both
// render as explicit "not available yet" states, never a fabricated
// number or a silently blank section.

const THIRTY_DAYS_AGO = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

function usd(n: number): string {
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
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

export default async function AdminHomePage() {
  const [
    costToday,
    costThisMonth,
    features,
    intents,
    visitorStats,
    customerStats,
    businessStats,
    revenue,
  ] = await Promise.all([
    totalCostToday(),
    totalCostThisMonth(),
    costByFeature(THIRTY_DAYS_AGO),
    costByBusinessIntent(THIRTY_DAYS_AGO),
    averageCostPerVisitor(THIRTY_DAYS_AGO),
    averageCostPerCustomer(THIRTY_DAYS_AGO),
    averageCostPerCreatedBusiness(THIRTY_DAYS_AGO),
    revenueVsAiCost(THIRTY_DAYS_AGO),
  ]);

  const byUsage = [...features].sort((a, b) => b.callCount - a.callCount);
  const highestCost = features[0];
  const lowestCost = features[features.length - 1];

  return (
    <main className="mx-auto max-w-4xl px-8 py-16">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">AI Cost &amp; Usage</h1>
        {/* This page is about spend. Operations is about whether anything is
            broken — a different question, and the one somebody arrives with
            during an incident, so it has to be reachable from here. */}
        <Link href="/admin/operations" className="text-xs text-zinc-500 underline dark:text-zinc-400">Operations</Link>
      </div>
      <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
        Internal — Genesis team only. Feature/intent figures below cover the last 30 days.
      </p>

      <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Card label="AI spend today" value={usd(costToday)} />
        <Card label="AI spend this month" value={usd(costThisMonth)} />
        <Card
          label="Avg cost / visitor"
          value={usd(visitorStats.avgCostUsd)}
          sub={`${visitorStats.visitorCount} visitors`}
        />
        <Card
          label="Avg cost / customer"
          value={usd(customerStats.avgCostUsd)}
          sub={`${customerStats.customerCount} accounts`}
        />
        <Card
          label="Avg cost / business created"
          value={usd(businessStats.avgCostUsd)}
          sub={`${businessStats.businessCount} created`}
        />
        <Card
          label="AI cost as % of revenue"
          value={revenue.aiCostAsPercentOfRevenue !== null ? `${revenue.aiCostAsPercentOfRevenue.toFixed(1)}%` : "—"}
          sub={revenue.totalRevenueUsd > 0 ? `${usd(revenue.totalRevenueUsd)} revenue` : "no revenue yet"}
        />
      </div>

      <h2 className="mt-12 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        Cost by feature
      </h2>
      <div className="mt-3 overflow-x-auto rounded-xl border border-black/[.08] dark:border-white/[.1]">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-black/[.08] text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-white/[.1] dark:text-zinc-400">
              <th className="px-4 py-2.5 font-medium">Feature</th>
              <th className="px-4 py-2.5 text-right font-medium">Calls</th>
              <th className="px-4 py-2.5 text-right font-medium">Total cost</th>
              <th className="px-4 py-2.5 text-right font-medium">Avg cost</th>
            </tr>
          </thead>
          <tbody>
            {features.map((f) => (
              <tr key={f.feature} className="border-b border-black/[.06] last:border-0 dark:border-white/[.06]">
                <td className="px-4 py-2.5 text-black dark:text-zinc-50">{f.feature}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-zinc-600 dark:text-zinc-300">{f.callCount}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-black dark:text-zinc-50">{usd(f.totalCostUsd)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-zinc-600 dark:text-zinc-300">{usd(f.avgCostUsd)}</td>
              </tr>
            ))}
            {features.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-zinc-500 dark:text-zinc-400">
                  No AI usage recorded in this window.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Highest cost: <span className="font-medium text-black dark:text-zinc-50">{highestCost?.feature ?? "—"}</span>
        </p>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Lowest cost: <span className="font-medium text-black dark:text-zinc-50">{lowestCost?.feature ?? "—"}</span>
        </p>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Most used: <span className="font-medium text-black dark:text-zinc-50">{byUsage[0]?.feature ?? "—"}</span>
          {" "}({byUsage[0]?.callCount ?? 0} calls)
        </p>
      </div>

      <h2 className="mt-12 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        Cost by business intent
      </h2>
      <div className="mt-3 overflow-x-auto rounded-xl border border-black/[.08] dark:border-white/[.1]">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-black/[.08] text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-white/[.1] dark:text-zinc-400">
              <th className="px-4 py-2.5 font-medium">Business intent</th>
              <th className="px-4 py-2.5 text-right font-medium">Calls</th>
              <th className="px-4 py-2.5 text-right font-medium">Total cost</th>
            </tr>
          </thead>
          <tbody>
            {intents.map((i) => (
              <tr key={i.businessIntent} className="border-b border-black/[.06] last:border-0 dark:border-white/[.06]">
                <td className="px-4 py-2.5 text-black dark:text-zinc-50">{i.businessIntent}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-zinc-600 dark:text-zinc-300">{i.callCount}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-black dark:text-zinc-50">{usd(i.totalCostUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="mt-12 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        Growth Credit economy
      </h2>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <NotAvailable reason="no subscription tier system exists yet — gross margin by tier isn't a real number to show." />
        <NotAvailable reason="Growth Credit values haven't been assigned to any action yet (lib/growthCreditCatalog.ts is intentionally empty) — nothing to compare API cost against." />
      </div>
    </main>
  );
}
