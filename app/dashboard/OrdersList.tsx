"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { toggleOrderFulfilled, purchaseShippingLabel } from "./actions";
import type { OrderShippingAddress } from "@/lib/orders/shippingAddress";
import { formatMoney } from "@/lib/money";
import { COMMERCE_LIST, COMMERCE_LIST_MARKER, COMMERCE_ROW } from "@/lib/dashboard/rooms";
import { stageOf, STAGE_LABEL } from "@/lib/carriage/lifecycle";

const STATUS_LABEL: Record<string, string> = {
  paid: "Paid",
  refunded: "Refunded",
};

export interface OrderRow {
  id: string;
  productName: string;
  quantity: number;
  buyerEmail: string;
  amountInCents: number | null;
  status: string;
  paymentProvider: string;
  createdAt: Date;
  fulfillmentStatus: string;
  /** From the carrier itself, never inferred. Null until one has told us anything. */
  shipmentStatus: string | null;
  deliveredAt: Date | null;
  shippingAddress: OrderShippingAddress | null;
  carrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  labelUrl: string | null;
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

function BuyLabelForm({ orderId }: { orderId: string }) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded-full bg-[var(--brand-accent,#2563eb)] px-3 py-1 text-xs font-medium text-white transition-opacity hover:opacity-90"
      >
        Buy shipping label
      </button>
    );
  }

  return (
    <form
      action={(formData) => startTransition(() => purchaseShippingLabel(formData))}
      className="flex flex-wrap items-center gap-2"
    >
      <input type="hidden" name="orderId" value={orderId} />
      <input
        name="weightOz"
        type="number"
        step="0.1"
        min="0.1"
        required
        placeholder="Weight (oz)"
        className="w-24 rounded-lg border border-black/[.08] px-2 py-1 text-xs dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
      />
      <input
        name="lengthIn"
        type="number"
        step="0.1"
        placeholder="L (in)"
        className="w-16 rounded-lg border border-black/[.08] px-2 py-1 text-xs dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
      />
      <input
        name="widthIn"
        type="number"
        step="0.1"
        placeholder="W (in)"
        className="w-16 rounded-lg border border-black/[.08] px-2 py-1 text-xs dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
      />
      <input
        name="heightIn"
        type="number"
        step="0.1"
        placeholder="H (in)"
        className="w-16 rounded-lg border border-black/[.08] px-2 py-1 text-xs dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
      />
      <button
        type="submit"
        disabled={isPending}
        className="rounded-full bg-[var(--brand-accent,#2563eb)] px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
      >
        {isPending ? "Buying..." : "Buy"}
      </button>
    </form>
  );
}

function OrderRowCard({
  order,
  currency,
  canViewRevenue,
  canManage,
  canBuyLabel,
  labelBlockedBy,
  basePath,
}: {
  order: OrderRow;
  /** The store's own, never a default that happens to be the developer's. */
  currency: string;
  canViewRevenue: boolean;
  canManage: boolean;
  // Priority 2 (shipping, 2026-08-09) — real, both prerequisites (USPS
  // connected AND a real ship-from address on file) checked once by the
  // page, not re-derived per row.
  canBuyLabel: boolean;
  /** Why not, when not — so a blocked order can say so instead of going quiet. */
  labelBlockedBy: "return_address" | "shipping_provider" | null;
  /** Where this business lives, so a row never links into another one. */
  basePath: string;
}) {
  const [isPending, startTransition] = useTransition();
  const isFulfilled = order.fulfillmentStatus === "fulfilled";
  const stage = stageOf(order);

  return (
    <li className={COMMERCE_ROW}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          {/* HOW MANY, next to what (2026-08-22, P1.7). The lifecycle the
              milestone names lists "customer / product / QUANTITY / payment
              status / shipping address / fulfillment status / tracking / order
              date". Every one of those was on this card except the quantity,
              which has existed on Order since 2026-08-20 and was rendered
              nowhere. An owner packing a hand-wound product read "Tensor Ring
              — $255.00" and had to divide to learn it was three of them. */}
          {/* The way in to the whole record (2026-08-25). The row carries what
              fits on a row; everything else about an order — the transaction
              id, the ship-from address, whether the buyer was ever told it
              shipped — lives on the detail page and had nowhere to be shown. */}
          <Link
            href={`${basePath}/orders/${order.id}`}
            className="text-sm font-medium text-black hover:underline dark:text-zinc-50"
          >
            {order.productName}
            {order.quantity > 1 && (
              <span className="ml-1.5 font-normal text-zinc-500">&times;{order.quantity}</span>
            )}
          </Link>
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
          {/* WHERE THE PARCEL IS, derived rather than stored, so it cannot
              drift from the fields it reads. Delivered outranks shipped only
              because delivery now comes from the carrier — before the tracker
              ingestion existed there was nothing to outrank it with. */}
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
              stage === "delivered"
                ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
                : "bg-black/5 text-zinc-600 dark:bg-white/10 dark:text-zinc-400"
            }`}
          >
            {STAGE_LABEL[stage]}
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

      {order.trackingNumber ? (
        <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
          Shipped via {order.carrier ?? "an unnamed carrier"} — tracking {order.trackingNumber}
          {order.trackingUrl && (
            <>
              {" "}
              ·{" "}
              <a href={order.trackingUrl} target="_blank" rel="noreferrer" className="underline">
                Track
              </a>
            </>
          )}
          {order.labelUrl && (
            <>
              {" "}
              ·{" "}
              <a href={order.labelUrl} target="_blank" rel="noreferrer" className="underline">
                Label
              </a>
            </>
          )}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-zinc-500">
          {order.paymentProvider} &middot; {order.createdAt.toLocaleDateString()}
          {canViewRevenue && order.amountInCents !== null && (
            <> &middot; {formatMoney(order.amountInCents, currency)}</>
          )}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {canManage && canBuyLabel && order.shippingAddress && !order.trackingNumber && (
            <BuyLabelForm orderId={order.id} />
          )}
          {/* AND WHEN IT CANNOT, WHY (2026-08-25). This branch used to be
              nothing at all: a paid order with a delivery address and no way to
              ship it, and no reason on the screen. Shown only for an order that
              would otherwise qualify, so a fulfilled or unaddressed order does
              not carry an explanation for a button it was never going to have. */}
          {canManage && !canBuyLabel && order.shippingAddress && !order.trackingNumber && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              {labelBlockedBy === "return_address"
                ? "Add your ship-from address below to buy a label for this order."
                : "Shipping isn't connected yet, so a label can't be bought for this order."}
            </p>
          )}
          {/* No "mark as unfulfilled" once a label exists — the parcel is in the
              post and the buyer has tracking, so the server refuses it. Offering
              a button that throws is worse than not offering it. Marking as
              fulfilled is still available for orders shipped by hand. */}
          {canManage && !(isFulfilled && order.trackingNumber) && (
            <button
              disabled={isPending}
              onClick={() => startTransition(() => toggleOrderFulfilled(order.id))}
              className="rounded-full border border-black/[.08] px-3 py-1 text-xs disabled:opacity-50 dark:border-white/[.145] dark:text-zinc-50"
            >
              {isPending ? "Updating..." : isFulfilled ? "Mark as unfulfilled" : "Mark as fulfilled"}
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

export function OrdersList({
  orders,
  currency,
  canViewRevenue,
  canManage,
  canBuyLabel,
  labelBlockedBy,
  basePath,
}: {
  orders: OrderRow[];
  currency: string;
  canViewRevenue: boolean;
  canManage: boolean;
  canBuyLabel: boolean;
  labelBlockedBy: "return_address" | "shipping_provider" | null;
  basePath: string;
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
          <ul className={`mt-3 ${COMMERCE_LIST}`} {...COMMERCE_LIST_MARKER}>
            {unfulfilled.map((order) => (
              <OrderRowCard
                key={order.id}
                order={order}
                currency={currency}
                canViewRevenue={canViewRevenue}
                canManage={canManage}
                canBuyLabel={canBuyLabel}
                labelBlockedBy={labelBlockedBy}
                basePath={basePath}
              />
            ))}
          </ul>
        </div>
      )}
      {fulfilled.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Fulfilled ({fulfilled.length})
          </h3>
          <ul className={`mt-3 ${COMMERCE_LIST}`} {...COMMERCE_LIST_MARKER}>
            {fulfilled.map((order) => (
              <OrderRowCard
                key={order.id}
                order={order}
                currency={currency}
                canViewRevenue={canViewRevenue}
                canManage={canManage}
                canBuyLabel={canBuyLabel}
                labelBlockedBy={labelBlockedBy}
                basePath={basePath}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
