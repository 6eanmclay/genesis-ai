"use client";

import Link from "next/link";
import { J4Icon } from "./J4Icon";
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
  /**
   * What this product weighs and measures, from the product itself.
   *
   * Defaults, not commitments — a parcel is the product plus whatever it is
   * packed in, so every field stays editable. What changes is that the common
   * case needs no typing at all.
   */
  /**
   * Who packs this — from the product's own sourceKind.
   *
   * A print-on-demand or dropshipped order is posted from the partner's
   * warehouse, so there is no parcel here to weigh and no label for this owner
   * to buy. "PARTNER" is not a blocked state to be fixed; it is the product
   * working as intended.
   */
  shippedBy: "OWNER" | "PARTNER" | "NOBODY";
  parcel: {
    weightOz: number | null;
    lengthIn: number | null;
    widthIn: number | null;
    heightIn: number | null;
  };
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

export function BuyLabelForm({
  orderId,
  parcel,
}: {
  orderId: string;
  parcel: OrderRow["parcel"];
}) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  // The common case: this product's weight is already on file, so the merchant
  // opens the form and presses the button. The fields stay editable because a
  // parcel is the product plus its packaging, and only the merchant knows what
  // they actually put it in.
  const knowsWeight = parcel.weightOz !== null && parcel.weightOz > 0;

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
      {/* SAID, NOT ASSUMED. Pre-filled numbers an owner did not type are worth
          a sentence — otherwise a wrong product weight becomes a wrong postage
          purchase that nobody looked at. And where the product carries no
          weight, the merchant needs to know why the box is empty. */}
      <p className="w-full text-xs text-zinc-500">
        {knowsWeight
          ? "From this product's saved weight and size — change them if this parcel differs."
          : "This product has no saved weight. Enter the parcel's weight to get a rate."}
      </p>
      <input
        name="weightOz"
        type="number"
        step="0.1"
        min="0.1"
        required
        defaultValue={parcel.weightOz ?? undefined}
        placeholder="Weight (oz)"
        className="w-24 rounded-lg border border-black/[.08] px-2 py-1 text-xs dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
      />
      <input
        name="lengthIn"
        type="number"
        step="0.1"
        defaultValue={parcel.lengthIn ?? undefined}
        placeholder="L (in)"
        className="w-16 rounded-lg border border-black/[.08] px-2 py-1 text-xs dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
      />
      <input
        name="widthIn"
        type="number"
        step="0.1"
        defaultValue={parcel.widthIn ?? undefined}
        placeholder="W (in)"
        className="w-16 rounded-lg border border-black/[.08] px-2 py-1 text-xs dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
      />
      <input
        name="heightIn"
        type="number"
        step="0.1"
        defaultValue={parcel.heightIn ?? undefined}
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

  // ============ THE WHOLE ROW OPENS THE ORDER (2026-09-17) ============
  /*
     *
     * Sean: "an order is presented as a large block of information with no
     * sufficiently clear 'this opens something' target... Define the
     * interaction boundary clearly — for example, the order row/card itself —
     * and make the entire interaction target obvious."
     *
     * Before this, the ONLY way into an order was the product name, a
     * hover-underline link a few characters wide inside a card several hundred
     * pixels tall. On a touchscreen there is no hover, so the affordance did
     * not exist at all until you happened to press the right words.
     *
     * A STRETCHED LINK, NOT A CLICKABLE DIV. The <Link> below stays the one
     * real link — it keeps the accessible name, the middle-click, the "open in
     * new tab", the status bar preview — and its ::after covers this row. So
     * there is exactly ONE link to the order, not a row-sized onClick shadowing
     * a second one, and a screen reader still hears "Tensor Ring × 3, link".
     *
     * `data-interactive` is what tells the global contract in globals.css that
     * this really does open something, so the press is acknowledged. It is an
     * author declaring intent — the same rule officeActions.ts holds after 198
     * Office rows shipped with a hover highlight and no destination.
     *
     * THE CONTROLS INSIDE STAY THEIR OWN TARGETS, lifted above the overlay:
     * tracking goes to the carrier, the label is a PDF, and "Mark as fulfilled"
     * changes the order. Those are genuinely different destinations rather than
     * "random pieces of the text", and collapsing them into the row would be
     * the opposite mistake.
     */
  return (
    <li className={`${COMMERCE_ROW} relative`} data-interactive="true">
      {/* ============ THIS ROW OPENS SOMETHING, AND SAYS SO ============
          Sean: an order was "presented as a large block of information with
          no sufficiently clear 'this opens something' target." The stretched
          link made the whole row pressable; it did not make the row LOOK
          pressable, and an affordance nobody can see is not an affordance.

          A chevron rather than a card. Commerce's ledger is deliberately a
          ruled sheet - "rows are separated by rules rather than by gaps
          between objects... no border and no radius" (lib/dashboard/rooms.ts,
          approved) - so putting a box around each order would answer this
          complaint by undoing a settled decision. The chevron says the same
          thing and keeps the sheet.

          Aligned to the top rather than centred: it points at the product
          name, which is what it opens. aria-hidden because the link beside it
          already carries the destination - a screen reader does not need to
          be told twice. */}
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
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
              // `after:absolute after:inset-0` is what turns the row into the
              // target. The link itself stays exactly where it is and keeps its
              // own text styling; only its hit area grows to the card.
              className="text-sm font-medium text-black after:absolute after:inset-0 after:content-[''] hover:underline dark:text-zinc-50"
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
            {/* ============ "PAID  PAID" (2026-09-17) ======================
             *
             * Seen on a real production screenshot: every unfulfilled order on
             * Cubit & Coil rendered NEEDS FULFILLMENT, then PAID, then PAID
             * again — two identical pills side by side.
             *
             * Neither is wrong and neither is redundant in general. `status` is
             * the MONEY (paid, refunded); `stage` is the LIFECYCLE (paid →
             * being prepared → on its way → delivered). They coincide only while
             * an order is paid and nothing has happened to it yet — which is
             * exactly the state most orders on a young shop are in, so the one
             * case where they agree is the common one.
             *
             * So the money pill is dropped only when it would repeat the stage
             * word for word. "Paid / On its way" still shows both, because there
             * the two say different things. No information is removed; a
             * duplicate is. */}
            {(STATUS_LABEL[order.status] ?? order.status) !== STAGE_LABEL[stage] && (
              <span className="rounded-full bg-black/5 px-2 py-0.5 text-[10px] uppercase tracking-wide text-zinc-600 dark:bg-white/10 dark:text-zinc-400">
                {STATUS_LABEL[order.status] ?? order.status}
              </span>
            )}
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
                <a href={order.trackingUrl} target="_blank" rel="noreferrer" className="relative z-10 underline">
                  Track
                </a>
              </>
            )}
            {order.labelUrl && (
              <>
                {" "}
                ·{" "}
                <a href={order.labelUrl} target="_blank" rel="noreferrer" className="relative z-10 underline">
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
            {/* PARTNER-SHIPPED ORDERS GET NO LABEL BUTTON (2026-08-26), and this
                is not a block — the parcel is in somebody else's warehouse and
                buying postage for it here would produce a label for a box that
                will never be attached to anything. */}
            {canManage && order.shippedBy === "PARTNER" && order.shippingAddress && !order.trackingNumber && (
              <p className="text-xs text-zinc-500">Your fulfilment partner ships this one.</p>
            )}
            {canManage && order.shippedBy === "OWNER" && canBuyLabel && order.shippingAddress && !order.trackingNumber && (
              <BuyLabelForm orderId={order.id} parcel={order.parcel} />
            )}
            {/* AND WHEN IT CANNOT, WHY (2026-08-25). This branch used to be
                nothing at all: a paid order with a delivery address and no way to
                ship it, and no reason on the screen. Shown only for an order that
                would otherwise qualify, so a fulfilled or unaddressed order does
                not carry an explanation for a button it was never going to have. */}
            {canManage && order.shippedBy === "OWNER" && !canBuyLabel && order.shippingAddress && !order.trackingNumber && (
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
                className="relative z-10 rounded-full border border-black/[.08] px-3 py-1 text-xs disabled:opacity-50 dark:border-white/[.145] dark:text-zinc-50"
              >
                {isPending ? "Updating..." : isFulfilled ? "Mark as unfulfilled" : "Mark as fulfilled"}
              </button>
            )}
          </div>
        </div>
        </div>
        <J4Icon name="chevron" size={16} aria-hidden
          className="mt-0.5 shrink-0 text-zinc-400 dark:text-zinc-500" />
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
