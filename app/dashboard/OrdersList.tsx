"use client";

import { useTransition } from "react";
import { toggleOrderFulfilled } from "./actions";
import type { OrderShippingAddress } from "@/lib/orders/shippingAddress";

const STATUS_LABEL: Record<string, string> = {
  paid: "Paid",
  refunded: "Refunded",
};

export interface OrderRow {
  id: string;
  productName: string;
  buyerEmail: string;
  amountInCents: number | null;
  status: string;
  paymentProvider: string;
  createdAt: Date;
  fulfillmentStatus: string;
  shippingAddress: OrderShippingAddress | null;
}

function formatAddress(address: OrderShippingAddress): string {
  return [
    address.name,
    address.line1,
    address.line2,
    [address.city, address.state, address.postalCode].filter(Boolean).join(", "),
    address.country,
  ]
    .filter(Boolean)
    .join(" · ");
}

function OrderRowCard({
  order,
  canViewRevenue,
  canManage,
}: {
  order: OrderRow;
  canViewRevenue: boolean;
  canManage: boolean;
}) {
  const [isPending, startTransition] = useTransition();
  const isFulfilled = order.fulfillmentStatus === "fulfilled";

  return (
    <li className="rounded-lg border border-black/[.08] p-4 dark:border-white/[.145]">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-black dark:text-zinc-50">{order.productName}</p>
          <p className="text-xs text-zinc-500">{order.buyerEmail}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
              isFulfilled
                ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
                : "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
            }`}
          >
            {isFulfilled ? "Fulfilled" : "Needs fulfillment"}
          </span>
          <span className="rounded-full bg-black/5 px-2 py-0.5 text-[10px] uppercase tracking-wide text-zinc-600 dark:bg-white/10 dark:text-zinc-400">
            {STATUS_LABEL[order.status] ?? order.status}
          </span>
        </div>
      </div>

      {order.shippingAddress && (
        <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
          Ship to: {formatAddress(order.shippingAddress)}
        </p>
      )}
      {!order.shippingAddress && (
        <p className="mt-2 text-xs text-zinc-500">No shipping address on file.</p>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-zinc-500">
          {order.paymentProvider} &middot; {order.createdAt.toLocaleDateString()}
          {canViewRevenue && order.amountInCents !== null && (
            <> &middot; ${(order.amountInCents / 100).toFixed(2)}</>
          )}
        </p>
        {canManage && (
          <button
            disabled={isPending}
            onClick={() => startTransition(() => toggleOrderFulfilled(order.id))}
            className="rounded-full border border-black/[.08] px-3 py-1 text-xs disabled:opacity-50 dark:border-white/[.145] dark:text-zinc-50"
          >
            {isPending ? "Updating..." : isFulfilled ? "Mark as unfulfilled" : "Mark as fulfilled"}
          </button>
        )}
      </div>
    </li>
  );
}

export function OrdersList({
  orders,
  canViewRevenue,
  canManage,
}: {
  orders: OrderRow[];
  canViewRevenue: boolean;
  canManage: boolean;
}) {
  if (orders.length === 0) {
    return <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">No orders yet.</p>;
  }

  const unfulfilled = orders.filter((o) => o.fulfillmentStatus !== "fulfilled");
  const fulfilled = orders.filter((o) => o.fulfillmentStatus === "fulfilled");

  return (
    <div className="mt-4 flex max-w-2xl flex-col gap-8">
      {unfulfilled.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Needs fulfillment ({unfulfilled.length})
          </h3>
          <ul className="mt-3 flex flex-col gap-3">
            {unfulfilled.map((order) => (
              <OrderRowCard key={order.id} order={order} canViewRevenue={canViewRevenue} canManage={canManage} />
            ))}
          </ul>
        </div>
      )}
      {fulfilled.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Fulfilled ({fulfilled.length})
          </h3>
          <ul className="mt-3 flex flex-col gap-3">
            {fulfilled.map((order) => (
              <OrderRowCard key={order.id} order={order} canViewRevenue={canViewRevenue} canManage={canManage} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
