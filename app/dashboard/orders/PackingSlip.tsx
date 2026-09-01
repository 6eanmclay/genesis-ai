import { prisma } from "@/lib/prisma";
import { notFound } from "next/navigation";
import { PrintButton } from "./PrintButton";

// THE SHEET THAT GOES IN THE BOX.
//
// ============ WHAT A PACKING SLIP IS FOR ==============================
//
// Packing one order correctly, and nothing else. Somebody stands at a table
// with a printed page, picks items off a shelf, checks them against a list and
// writes an address on a parcel. Every decision here follows from that.
//
// ============ SO IT CARRIES NO PAYMENT DETAIL =========================
//
// Sean: "Do not expose unnecessary payment information on the packing slip."
//
// The order detail screen has the card reference, the Stripe payment id and
// the full money breakdown, and that screen is behind a login. This sheet gets
// printed, carried around a room and dropped in a box that goes to a customer's
// house — and the CUSTOMER is not the only person who might read it in
// transit. It shows what was bought and where it goes.
//
// Prices are shown per line and as a total because a customer opening a parcel
// reasonably expects to see what they paid for, and because a merchant needs to
// spot a wrong item by more than its name. What is NOT here is the payment
// reference, the provider, the card, the fee, the discount mechanics, or the
// buyer's email — none of which helps anybody pack anything.
//
// ============ AND IT READS THE SAME ROW THE DETAIL PAGE DOES ==========
//
// Same Order, same OrderItem, same store scoping. A packing slip that
// disagreed with the order screen would be worse than no packing slip, so
// there is no second query shape and no second source of truth.

interface PackingSlipProps {
  orderId: string;
  storeId: string;
}

interface ShippingAddress {
  name?: string;
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

interface StoreReturnAddress {
  name: string;
  line1: string;
  line2?: string | null;
  city: string;
  state: string | null;
  postalCode: string;
  country?: string;
}

function money(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

export async function PackingSlip({ orderId, storeId }: PackingSlipProps) {
  // Store-scoped, exactly as the order detail page reads it. An order id from
  // another business cannot be printed by guessing the URL.
  const order = await prisma.order.findFirst({
    where: { id: orderId, storeId },
    include: {
      store: { select: { name: true, currency: true, returnAddress: true } },
      items: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!order) notFound();

  const address = order.shippingAddress as ShippingAddress | null;
  const from = order.store.returnAddress as unknown as StoreReturnAddress | null;
  const currency = order.store.currency;

  // ============ EVERY LINE, OR THE ROW WHEN THERE ARE NONE ==========
  //
  // The same fallback the order screen uses. Order.productName is a SUMMARY on
  // a multi-product order — "…and 1 more" — and packing from a summary is how
  // the wrong thing ends up in the box. Orders written before bags exist have
  // no items and carry their single product on the row, which for them is the
  // whole truth rather than a summary.
  const lines =
    order.items.length > 0
      ? order.items.map((item) => ({
          name: item.productName,
          quantity: item.quantity,
          subtotalInCents: item.subtotalInCents,
        }))
      : [{ name: order.productName, quantity: order.quantity, subtotalInCents: order.amountInCents }];

  const itemCount = lines.reduce((n, l) => n + l.quantity, 0);

  return (
    <div className="mx-auto max-w-[820px] bg-white p-10 text-black print:p-0">
      {/* Hidden when printed: a button on a piece of paper is just ink. */}
      <div className="mb-6 flex items-center justify-between print:hidden">
        <PrintButton />
        <p className="text-xs text-zinc-500">
          {itemCount} item{itemCount === 1 ? "" : "s"} to pack
        </p>
      </div>

      <div className="flex items-start justify-between gap-8 border-b border-black/20 pb-4">
        <div>
          <h1 className="text-xl font-semibold">{order.store.name}</h1>
          <p className="mt-0.5 text-xs uppercase tracking-wide text-zinc-500">Packing slip</p>
        </div>
        <div className="text-right text-xs">
          {/* The order number a merchant and a customer can both quote. */}
          <p className="font-mono font-medium">{order.id}</p>
          <p className="mt-0.5 text-zinc-600">
            {order.createdAt.toLocaleDateString(undefined, {
              year: "numeric", month: "long", day: "numeric",
            })}
          </p>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-8 text-xs">
        <div>
          <p className="mb-1 font-semibold uppercase tracking-wide text-zinc-500">Ship to</p>
          {address?.line1 ? (
            <address className="not-italic leading-relaxed">
              {address.name && <div className="font-medium">{address.name}</div>}
              <div>{address.line1}</div>
              {address.line2 && <div>{address.line2}</div>}
              <div>
                {[address.city, address.state, address.postalCode].filter(Boolean).join(", ")}
              </div>
              {address.country && <div>{address.country}</div>}
            </address>
          ) : (
            // Said out loud. A blank block on a printed page reads as a
            // formatting problem; this reads as the fact it is, and it is the
            // one fact that stops the parcel going anywhere.
            <p className="font-medium text-red-700">
              No shipping address was recorded for this order.
            </p>
          )}
        </div>

        {from && (
          <div>
            <p className="mb-1 font-semibold uppercase tracking-wide text-zinc-500">From</p>
            <address className="not-italic leading-relaxed text-zinc-700">
              <div>{from.name}</div>
              <div>{from.line1}</div>
              {from.line2 && <div>{from.line2}</div>}
              <div>{[from.city, from.state, from.postalCode].filter(Boolean).join(", ")}</div>
            </address>
          </div>
        )}
      </div>

      <table className="mt-8 w-full text-xs">
        <thead>
          <tr className="border-b border-black/20 text-left">
            <th className="pb-2 font-semibold uppercase tracking-wide text-zinc-500">Item</th>
            <th className="w-16 pb-2 text-center font-semibold uppercase tracking-wide text-zinc-500">
              Qty
            </th>
            <th className="w-24 pb-2 text-right font-semibold uppercase tracking-wide text-zinc-500">
              Price
            </th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line, index) => (
            <tr key={`${line.name}-${index}`} className="border-b border-black/[.08]">
              <td className="py-2.5">{line.name}</td>
              {/* Large and centred on purpose: quantity is the number somebody
                  miscounts, and it is the one worth reading at arm's length. */}
              <td className="py-2.5 text-center text-sm font-semibold tabular-nums">{line.quantity}</td>
              <td className="py-2.5 text-right tabular-nums">{money(line.subtotalInCents, currency)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td className="pt-3 text-right font-semibold" colSpan={2}>
              Total
            </td>
            <td className="pt-3 text-right font-semibold tabular-nums">
              {money(order.amountInCents, currency)}
            </td>
          </tr>
        </tfoot>
      </table>

      {order.trackingNumber && (
        <p className="mt-6 text-xs text-zinc-600">
          {order.carrier ?? "Tracking"}: <span className="font-mono">{order.trackingNumber}</span>
        </p>
      )}

      <p className="mt-10 border-t border-black/[.08] pt-4 text-center text-xs text-zinc-500">
        Thank you for your order.
      </p>
    </div>
  );
}
