import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { notFound } from "next/navigation";
import { formatMoney } from "@/lib/money";
import { orderMoney } from "@/lib/orders/orderMoney";
import { DEFAULT_THEME, type Theme, themeCssVars } from "@/lib/theme";
import { PERMISSIONS, hasPermission } from "@/lib/permissions";
import type { StoreRole } from "@prisma/client";
import { AddTrackingPanel } from "./AddTrackingPanel";
import { BuyLabelForm } from "@/app/dashboard/OrdersList";

// THE WHOLE RECORD OF ONE ORDER, IN ONE PLACE.
//
// Orders existed only as rows in a list. Everything the schema already knows
// about an order — who bought it, where it is going, what was paid and through
// which transaction, what shipped and under what tracking — was either squeezed
// into a row or not shown at all.
//
// Nothing here is computed or inferred. Every value is a column that already
// existed; this milestone added no field to the Order model. What was missing
// was a screen, not data.
//
// A NULL IS SHOWN AS A NULL. An order with no shipping address says so rather
// than rendering an empty block, because "we were never given one" and "it is
// here but blank" are different problems for the merchant.

interface OrderDetailProps {
  orderId: string;
  storeId: string;
  role: StoreRole;
  basePath: string;
}

/** The store's own ship-from address, as the Orders page records it. */
interface StoreReturnAddress {
  name: string;
  line1: string;
  city: string;
  state: string | null;
  postalCode: string;
}

/** A shipping address as checkout recorded it. */
interface ShippingAddress {
  name?: string;
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-wrap justify-between gap-2 py-1.5">
      <span className="text-xs text-zinc-500 dark:text-zinc-400">{label}</span>
      <span className="text-xs text-black dark:text-zinc-50">{value}</span>
    </div>
  );
}

/** Not shown as a blank — the merchant needs to know it was never supplied. */
function NotProvided() {
  return <span className="text-zinc-400 dark:text-zinc-500">Not provided</span>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-black/[.08] p-4 dark:border-white/[.145]">
      <h2 className="text-sm font-semibold text-black dark:text-zinc-50">{title}</h2>
      <div className="mt-2 divide-y divide-black/[.04] dark:divide-white/[.06]">{children}</div>
    </section>
  );
}

export async function OrderDetail({ orderId, storeId, role, basePath }: OrderDetailProps) {
  // Store-scoped, so an order id from another business cannot be opened by
  // guessing it — the same rule every other read in this codebase follows.
  const order = await prisma.order.findFirst({
    where: { id: orderId, storeId },
    include: {
      store: { select: { currency: true, theme: true, returnAddress: true } },
      // The parcel the merchant should not have to retype — see BuyLabelForm.
      product: { select: { weightOz: true, lengthIn: true, widthIn: true, heightIn: true } },
      // ============ WHAT IS ACTUALLY IN THE BOX (2026-08-31) ==========
      //
      // The row's own productName is a SUMMARY: a two-product order reads
      // "Hand-Wound Copper Tensor Ring Cuff Bracelet and 1 more". This page
      // showed exactly that and nothing else, so an owner packing a real order
      // could not see the second item — a necklace, in the live order that
      // prompted this. Unshippable from this screen, which is the one screen
      // that exists to ship from.
      items: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!order) notFound();

  // WHETHER A LABEL CAN BE BOUGHT AT ALL, decided the same way the Orders list
  // decides it: a verified-working shipping connection AND a ship-from address.
  // Read here rather than passed in, so this page cannot disagree with itself
  // about what it is showing.
  const shipping = await prisma.storeIntegration.findUnique({
    where: { storeId_provider: { storeId, provider: "EASYPOST" } },
  });

  const currency = order.store.currency;
  const theme = (order.store.theme as Theme | null) ?? DEFAULT_THEME;
  const address = order.shippingAddress as ShippingAddress | null;
  const returnAddress = order.store.returnAddress as unknown as StoreReturnAddress | null;
  const canViewRevenue = hasPermission(role, PERMISSIONS.REVENUE_VIEW);
  const items = order.items;

  // The arithmetic lives in lib/orders/orderMoney.ts, imported by this page AND
  // by its suite. It was inline here, and the suite kept a copy — so breaking
  // this page's version left the suite green, which is the seam that replaces
  // what it tests. See that file's own comment.
  const { subtotal, discount, promotionLabel } = orderMoney(order, items);

  // ============ WHAT HAPPENED TO THIS ORDER, IN ORDER ==============
  //
  // Built from the timestamps the row already carries rather than from a new
  // table. Every entry is a column that is either set or not — nothing here is
  // inferred, and an event with no timestamp simply does not appear, which is
  // why "paid" and "delivered" can both be absent without the list lying.
  const timeline = [
    { at: order.createdAt, what: "Order placed and paid" },
    { at: order.confirmationSentAt, what: "Receipt emailed to the customer" },
    { at: order.fulfilledAt, what: "Marked fulfilled by the owner" },
    { at: order.labelClaimedAt, what: "Shipping label bought" },
    { at: order.shipmentNotifiedAt, what: "Customer told it shipped" },
    { at: order.lastScanAt, what: "Last carrier scan" },
    { at: order.deliveredAt, what: "Delivered" },
    { at: order.disputedAt, what: "Payment disputed" },
    { at: order.disputeFundsWithdrawnAt, what: "Funds withdrawn by the bank" },
    { at: order.disputeFundsReinstatedAt, what: "Funds returned" },
    { at: order.disputeResolvedAt, what: "Dispute closed" },
  ]
    .filter((entry): entry is { at: Date; what: string } => entry.at instanceof Date)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  const canManage = hasPermission(role, PERMISSIONS.ORDERS_MANAGE);
  // Strict, exactly as the Orders list is: only a verified-working connection
  // counts, because this gates an action that spends real postage.
  const canBuyLabel = Boolean(
    shipping?.status === "CONNECTED" && returnAddress && order.shippingAddress
  );

  return (
    <div style={themeCssVars(theme)} className="min-h-screen p-8 lg:min-h-0">
      <Link href={`${basePath}/orders`} className="text-xs text-zinc-500 hover:underline">
        ← All orders
      </Link>
      <h1 className="mt-2 text-2xl font-semibold text-black dark:text-zinc-50">
        {order.productName}
      </h1>
      <p className="mt-1 text-sm text-zinc-500">
        Ordered {order.createdAt.toLocaleDateString()} · {order.status}
        {order.fulfillmentStatus === "fulfilled" ? " · fulfilled" : " · awaiting fulfilment"}
      </p>

      <div className="mt-6 grid max-w-3xl grid-cols-1 gap-4 sm:grid-cols-2">
        <Section title="Customer">
          <Field label="Email" value={order.buyerEmail} />
          <Field label="Name" value={address?.name ?? <NotProvided />} />
        </Section>

        <Section title="Payment">
          <Field label="Provider" value={order.paymentProvider} />
          <Field label="Status" value={order.status} />
          {/* The transaction id, which is what a merchant quotes to a payment
              provider when something needs looking into. */}
          <Field label="Transaction ID" value={order.externalPaymentId ?? <NotProvided />} />
          <Field label="Order reference" value={order.externalOrderId} />
        </Section>

        <Section title="Shipping to">
          {address ? (
            <>
              <Field label="Address" value={address.line1 ?? <NotProvided />} />
              {address.line2 && <Field label="" value={address.line2} />}
              <Field
                label="City"
                value={[address.city, address.state, address.postalCode].filter(Boolean).join(", ") || <NotProvided />}
              />
              <Field label="Country" value={address.country ?? <NotProvided />} />
            </>
          ) : (
            // A real state, and one that matters: no label can be bought for
            // this order, and the merchant needs to know why before they look
            // for a button that is not there.
            <p className="py-2 text-xs text-amber-700 dark:text-amber-400">
              No delivery address was recorded with this order, so it cannot be shipped through
              Genesis. Contact the customer for one.
            </p>
          )}
        </Section>

        <Section title="Shipping from">
          {returnAddress ? (
            <>
              <Field label="Name" value={returnAddress.name} />
              <Field label="Address" value={returnAddress.line1} />
              <Field
                label="City"
                value={[returnAddress.city, returnAddress.state, returnAddress.postalCode].filter(Boolean).join(", ")}
              />
            </>
          ) : (
            <p className="py-2 text-xs text-amber-700 dark:text-amber-400">
              You have not set a ship-from address yet. Add one on the Orders page before buying a
              label.
            </p>
          )}
        </Section>

        <Section title="What to pack">
          {/* ============ EVERY LINE, NOT A SUMMARY (2026-08-31) =======
              order.productName is "…and 1 more" on a multi-product order, and
              that summary was all this page showed. The real lines live in
              OrderItem and have since bags existed; nothing rendered them.

              Older orders have no OrderItem rows at all — every order written
              before bags carries its single product on the row itself. Those
              fall through to the row, which for them is the complete truth
              rather than a summary. */}
          {items.length > 0 ? (
            items.map((item) => (
              <Field
                key={item.id}
                label={`${item.productName} × ${item.quantity}`}
                value={canViewRevenue ? formatMoney(item.subtotalInCents, currency) : null}
              />
            ))
          ) : (
            <Field
              label={`${order.productName} × ${order.quantity}`}
              value={canViewRevenue ? formatMoney(order.amountInCents, currency) : null}
            />
          )}
        </Section>

        {canViewRevenue && (
          <Section title="What was paid">
            {/* ============ THE ARITHMETIC, SHOWN (2026-08-31) =========
                An owner reconciling against Stripe needs the total to be
                explicable, and this page previously showed one number.

                Derived from the line items when there are any, because on the
                live orders the ORDER-level listSubtotalInCents and
                discountInCents are null while every item carries its own — so
                reading only the columns would print "no discount" over an
                order that really had one. The columns win when they are set;
                the items answer when they are not. */}
            <Field label="Subtotal" value={subtotal !== null ? formatMoney(subtotal, currency) : <NotProvided />} />
            {discount !== null && discount > 0 && (
              <Field
                label={promotionLabel ? `Discount (${promotionLabel})` : "Discount"}
                value={`− ${formatMoney(discount, currency)}`}
              />
            )}
            <Field
              label="Shipping charged"
              value={
                order.shippingChargedInCents !== null ? (
                  formatMoney(order.shippingChargedInCents, currency)
                ) : (
                  <NotProvided />
                )
              }
            />
            {/* ============ TAX IS NOT RECORDED ANYWHERE =============
                Not omitted, and not invented. No column on Order, OrderItem or
                anywhere else in the schema holds a tax amount, and checkout
                never asked Stripe for one. Printing "—" would read as "no tax
                was charged", which is a different claim and one this platform
                cannot make. It says where the answer really is instead. */}
            <Field
              label="Tax"
              value={<span className="text-zinc-500">Not recorded — check Stripe</span>}
            />
            <Field label="Total paid" value={<strong>{formatMoney(order.amountInCents, currency)}</strong>} />
            {order.shippingCostInCents !== null && (
              // What postage actually cost, which is not the same number as
              // what the customer was charged for it.
              <Field label="Postage cost to you" value={formatMoney(order.shippingCostInCents, currency)} />
            )}
          </Section>
        )}

        <Section title="Fulfilment">
          <Field label="State" value={order.fulfillmentStatus} />
          <Field
            label="Fulfilled"
            value={order.fulfilledAt ? order.fulfilledAt.toLocaleDateString() : <NotProvided />}
          />
          <Field
            label="Delivered"
            value={order.deliveredAt ? order.deliveredAt.toLocaleDateString() : <NotProvided />}
          />
          {/* ============ WHAT THE CUSTOMER HAS ACTUALLY BEEN TOLD =====
              Three separate facts, because they fail separately. A receipt can
              send while the shipped notice does not, and an owner who can only
              see one of them cannot tell which of their customers is waiting in
              silence.

              "Not yet" is amber rather than blank for the reason the shipped
              row already records: on a deployment with no email configured this
              is the norm, and the merchant is the only one who can tell them. */}
          <Field
            label="Customer sent a receipt"
            value={
              order.confirmationSentAt ? (
                order.confirmationSentAt.toLocaleDateString()
              ) : (
                <span className="text-amber-700 dark:text-amber-400">Not yet</span>
              )
            }
          />
          <Field
            label="Customer told it shipped"
            value={
              order.shipmentNotifiedAt ? (
                order.shipmentNotifiedAt.toLocaleDateString()
              ) : (
                // Not a blank. On a deployment with no email configured this is
                // the norm, and the merchant is the only one who can tell them.
                <span className="text-amber-700 dark:text-amber-400">Not yet</span>
              )
            }
          />
          {/* Only shown once the fact they describe is true. An order that has
              not been delivered has nothing to say about a delivery email, and
              a row reading "Not yet" against an event that has not happened
              would look like a failure rather than a sequence. */}
          {order.deliveredAt && (
            <Field
              label="Customer told it arrived"
              value={
                order.deliveryNotifiedAt ? (
                  order.deliveryNotifiedAt.toLocaleDateString()
                ) : (
                  <span className="text-amber-700 dark:text-amber-400">Not yet</span>
                )
              }
            />
          )}
          {order.status === "refunded" && (
            <Field
              label="Customer told about the refund"
              value={
                order.refundNotifiedAt ? (
                  order.refundNotifiedAt.toLocaleDateString()
                ) : (
                  <span className="text-amber-700 dark:text-amber-400">Not yet</span>
                )
              }
            />
          )}
        </Section>
      </div>

      <div className="mt-4 max-w-3xl">
        <Section title="Tracking">
          {order.trackingNumber ? (
            <>
              <Field label="Carrier" value={order.carrier ?? <NotProvided />} />
              <Field
                label="Tracking number"
                value={
                  order.trackingUrl ? (
                    <a href={order.trackingUrl} target="_blank" rel="noopener noreferrer" className="underline">
                      {order.trackingNumber}
                    </a>
                  ) : (
                    order.trackingNumber
                  )
                }
              />
              {order.labelUrl && (
                <Field
                  label="Label"
                  value={
                    // Opens the carrier's own PDF, which is what gets printed.
                    <a href={order.labelUrl} target="_blank" rel="noopener noreferrer" className="underline">
                      Print label
                    </a>
                  }
                />
              )}
            </>
          ) : canManage ? (
            <>
              {/* THE PRIMARY PATH FIRST. Buying the label inside Genesis is the
                  intended flow; entering a number by hand is the fallback for a
                  merchant who bought postage elsewhere. Order on the page says
                  which is which without a word of explanation. */}
              {canBuyLabel ? (
                <div className="py-2">
                  <BuyLabelForm
                    orderId={order.id}
                    parcel={{
                      weightOz: order.product?.weightOz ?? null,
                      lengthIn: order.product?.lengthIn ?? null,
                      widthIn: order.product?.widthIn ?? null,
                      heightIn: order.product?.heightIn ?? null,
                    }}
                  />
                </div>
              ) : (
                <p className="py-2 text-xs text-amber-700 dark:text-amber-400">
                  {!returnAddress
                    ? "Add your ship-from address on the Orders page to buy a label here."
                    : "Shipping isn't connected yet, so a label can't be bought for this order."}
                </p>
              )}
              <div className="border-t border-black/[.04] pt-2 dark:border-white/[.06]">
                <p className="text-xs text-zinc-500">
                  Already bought postage elsewhere? Add the tracking number.
                </p>
                <AddTrackingPanel orderId={order.id} />
              </div>
            </>
          ) : (
            <p className="py-2 text-xs text-zinc-500">No tracking yet.</p>
          )}
        </Section>

        {/* ============ A DISPUTE, ONLY WHEN THERE IS ONE (2026-08-31) ===
            Rendered only if the card network has actually said something. An
            always-present "Disputes: none" row on every healthy order is noise
            that teaches an owner to stop reading this page.

            The two facts stay apart, exactly as the schema keeps them: what is
            CLAIMED (disputeStatus, which includes inquiries that move no money)
            and whether money actually MOVED (the withdrawn/reinstated stamps).
            Collapsing them would tell a merchant they had lost funds over a
            question the bank merely asked. */}
        {order.disputeStatus && (
          <Section title="Dispute">
            <Field label="Claim" value={order.disputeStatus} />
            <Field label="Reason given" value={order.disputeReason ?? <NotProvided />} />
            <Field
              label="Amount claimed"
              value={
                order.disputeAmountInCents !== null ? (
                  formatMoney(order.disputeAmountInCents, currency)
                ) : (
                  <NotProvided />
                )
              }
            />
            <Field
              label="Money actually moved"
              value={
                order.disputeFundsWithdrawnAt ? (
                  order.disputeFundsReinstatedAt ? (
                    <span className="text-emerald-700 dark:text-emerald-400">
                      Withdrawn, then returned
                    </span>
                  ) : (
                    <span className="text-amber-700 dark:text-amber-400">
                      Withdrawn {order.disputeFundsWithdrawnAt.toLocaleDateString()}
                    </span>
                  )
                ) : (
                  "No — the claim has not taken funds"
                )
              }
            />
          </Section>
        )}

        {/* ============ WHAT HAPPENED, IN ORDER ======================
            The same timestamps shown as fields above, read as a sequence. Two
            different questions — "is it shipped?" and "what has happened to
            this order?" — and the second one had no answer anywhere. */}
        <Section title="History">
          <ol className="flex flex-col gap-1.5">
            {timeline.map((entry) => (
              <li key={`${entry.what}-${entry.at.toISOString()}`} className="flex flex-wrap justify-between gap-2">
                <span className="text-xs text-black dark:text-zinc-50">{entry.what}</span>
                <span className="text-xs text-zinc-500">{entry.at.toLocaleString()}</span>
              </li>
            ))}
          </ol>
        </Section>
      </div>
    </div>
  );
}
