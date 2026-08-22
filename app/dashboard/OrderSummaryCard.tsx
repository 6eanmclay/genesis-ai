import type { OrderSummary } from "@/lib/dashboard/types";
import { formatMoney } from "@/lib/money";

export function OrderSummaryCard({
  summary,
  currency,
}: {
  summary: OrderSummary;
  /** The store's own — this card is the owner's revenue, in their money. */
  currency: string;
}) {
  return (
    <div className="rounded-lg border border-black/[.08] p-4 dark:border-white/[.145]">
      <p className="text-xs uppercase tracking-wide text-zinc-500">{summary.windowLabel}</p>
      <div className="mt-2 flex items-baseline gap-2">
        <p className="text-2xl font-semibold text-black dark:text-zinc-50">{summary.orderCount}</p>
        <p className="text-sm text-zinc-500">order{summary.orderCount === 1 ? "" : "s"}</p>
      </div>
      {summary.revenueInCents !== null && (
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          {formatMoney(summary.revenueInCents, currency)} in revenue
        </p>
      )}
      <p className="mt-3 text-xs text-zinc-500">
        {summary.allTimeOrderCount} order{summary.allTimeOrderCount === 1 ? "" : "s"} all time
        {summary.allTimeRevenueInCents !== null && ` — ${formatMoney(summary.allTimeRevenueInCents, currency)} total`}
      </p>
    </div>
  );
}
