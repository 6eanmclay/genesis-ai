import Link from "next/link";
import { formatMoney } from "@/lib/money";
import type { RecentOrder } from "@/lib/dashboard/types";

// Purely informational — orders are positive business activity, not a
// problem needing a decision, so this never renders next to Attention/
// Approvals. There's no fulfillment/shipping status anywhere in the data
// model today, so this deliberately doesn't invent a "mark as shipped"
// action — just the real order, and a deep-link to the full untouched
// Orders page for anything more.
export function RecentOrdersCard({
  orders,
  basePath,
  currency,
}: {
  orders: RecentOrder[];
  /** The business the owner is standing in — never the account's last active one. */
  basePath: string;
  /** The store's own — these are real sales in the owner's money. */
  currency: string;
}) {
  if (orders.length === 0) {
    return null;
  }

  return (
    <div className="mt-4 flex max-w-md flex-col gap-3">
      <ul className="flex flex-col divide-y divide-black/[.05] dark:divide-white/[.08]">
        {orders.map((order) => (
          <li key={order.id} className="flex items-center justify-between gap-3 py-2.5 first:pt-0">
            <div>
              <p className="text-sm font-medium text-black dark:text-zinc-50">{order.productName}</p>
              <p className="text-xs text-zinc-500">{order.buyerEmail}</p>
            </div>
            <div className="text-right">
              {order.amountInCents !== null && (
                <p className="text-sm font-medium text-black dark:text-zinc-50">
                  {formatMoney(order.amountInCents, currency)}
                </p>
              )}
              <p className="text-xs text-zinc-500">{order.createdAt.toLocaleDateString()}</p>
            </div>
          </li>
        ))}
      </ul>
      <Link
        href={`${basePath}/orders`}
        className="self-start text-xs font-medium text-[var(--brand-accent,#2563eb)] underline"
      >
        View all orders
      </Link>
    </div>
  );
}
