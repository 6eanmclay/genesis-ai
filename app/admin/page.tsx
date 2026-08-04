import { totalCostToday, totalCostThisMonth } from "@/lib/admin/aiUsageQueries";

// AI Cost & Usage Infrastructure, Milestone 6 — the minimal shell proving
// the real gate (app/admin/layout.tsx) and the real cross-tenant query
// path (lib/admin/aiUsageQueries.ts) both work end to end. Deliberately
// just raw numbers, no charts yet — Milestone 7 builds the real dashboard
// on top of this same, already-proven foundation.
export default async function AdminHomePage() {
  const [costToday, costThisMonth] = await Promise.all([totalCostToday(), totalCostThisMonth()]);

  return (
    <main className="mx-auto max-w-2xl px-8 py-16">
      <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">AI Cost &amp; Usage</h1>
      <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">Internal — Genesis team only.</p>
      <dl className="mt-8 grid grid-cols-2 gap-6">
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            AI spend today
          </dt>
          <dd className="mt-1 text-2xl font-semibold tabular-nums text-black dark:text-zinc-50">
            ${costToday.toFixed(2)}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            AI spend this month
          </dt>
          <dd className="mt-1 text-2xl font-semibold tabular-nums text-black dark:text-zinc-50">
            ${costThisMonth.toFixed(2)}
          </dd>
        </div>
      </dl>
    </main>
  );
}
