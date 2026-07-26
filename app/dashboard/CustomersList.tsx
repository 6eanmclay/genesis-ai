import type { CustomerSummary } from "@/lib/dashboard/types";

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function CustomersList({ customers }: { customers: CustomerSummary[] }) {
  if (customers.length === 0) {
    return <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">No customers yet.</p>;
  }
  return (
    <ul className="mt-4 flex max-w-md flex-col gap-2">
      {customers.map((customer) => (
        <li
          key={customer.buyerEmail}
          className="flex items-center justify-between rounded-lg border border-black/[.08] px-3 py-2 dark:border-white/[.145]"
        >
          <div>
            <p className="text-sm text-black dark:text-zinc-50">{customer.buyerEmail}</p>
            <p className="text-xs text-zinc-500">
              {customer.orderCount} order{customer.orderCount === 1 ? "" : "s"} — last{" "}
              {customer.lastOrderAt.toLocaleDateString()}
            </p>
          </div>
          {customer.totalSpentInCents !== null && (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              {formatCents(customer.totalSpentInCents)}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}
