"use client";

import { useState } from "react";
import type { CustomerSummary, RecentOrder } from "@/lib/dashboard/types";
import { formatMoney } from "@/lib/money";

function CustomerRow({
  customer,
  segments,
  orders,
  currency,
}: {
  customer: CustomerSummary;
  segments: string[];
  orders: RecentOrder[];
  /** The store's own. This is what a real customer really paid them. */
  currency: string;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <li className="rounded-lg border border-black/[.08] px-3 py-2 dark:border-white/[.145]">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <div>
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="text-sm text-black dark:text-zinc-50">{customer.buyerEmail}</p>
            {segments.map((segment) => (
              <span
                key={segment}
                className="rounded-full bg-black/5 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-600 dark:bg-white/10 dark:text-zinc-400"
              >
                {segment}
              </span>
            ))}
          </div>
          <p className="text-xs text-zinc-500">
            {customer.orderCount} order{customer.orderCount === 1 ? "" : "s"} — last{" "}
            {customer.lastOrderAt.toLocaleDateString()}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {customer.totalSpentInCents !== null && (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              {formatMoney(customer.totalSpentInCents, currency)}
            </p>
          )}
          <span className="text-xs text-zinc-400">{expanded ? "−" : "+"}</span>
        </div>
      </button>

      {expanded && (
        <ul className="mt-2 flex flex-col gap-1 border-t border-black/[.05] pt-2 dark:border-white/[.08]">
          {orders.length === 0 ? (
            <li className="text-xs text-zinc-500">No order history found.</li>
          ) : (
            orders.map((order) => (
              <li key={order.id} className="flex items-center justify-between text-xs">
                <span className="text-zinc-600 dark:text-zinc-400">
                  {order.productName} — {order.createdAt.toLocaleDateString()}
                </span>
                {order.amountInCents !== null && (
                  <span className="text-zinc-500">{formatMoney(order.amountInCents, currency)}</span>
                )}
              </li>
            ))
          )}
        </ul>
      )}
    </li>
  );
}

export function CustomersList({
  customers,
  segmentsByEmail,
  ordersByEmail,
  currency,
}: {
  customers: CustomerSummary[];
  currency: string;
  segmentsByEmail?: Map<string, string[]>;
  ordersByEmail?: Map<string, RecentOrder[]>;
}) {
  if (customers.length === 0) {
    return <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">No customers yet.</p>;
  }
  return (
    <ul className="mt-4 flex max-w-md flex-col gap-2">
      {customers.map((customer) => (
        <CustomerRow
          key={customer.buyerEmail}
          customer={customer}
          currency={currency}
          segments={segmentsByEmail?.get(customer.buyerEmail) ?? []}
          orders={ordersByEmail?.get(customer.buyerEmail) ?? []}
        />
      ))}
    </ul>
  );
}
