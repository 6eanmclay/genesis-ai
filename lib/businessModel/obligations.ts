import { prisma } from "@/lib/prisma";
import { getFulfillmentBreakdown } from "@/lib/dashboard/whatHappened";

// M6 (2026-08-18) — J4 understands obligations, not just income.
//
// THE GAP. Order already carries fulfillmentStatus, fulfilledAt, carrier,
// trackingNumber and createdAt, and getFulfillmentBreakdown already counts
// fulfilled vs unfulfilled — for the Analytics page, its only caller. None of
// it reached J4. mapOrdersToTransactions sets `status: order.status`, which is
// PAYMENT state ("paid" / "refunded") on a different axis entirely, so the
// canonical transaction J4 sees says money arrived and never says whether
// anything shipped.
//
// An owner asking "does anyone need a package?" — the most time-critical
// question a physical-goods business has — got nothing, while the Order row
// held the tracking number.
//
// THE HONESTY PROBLEM AT THE CENTRE OF THIS FILE. Four facts live here that
// look alike and are not:
//
//   status: "paid"          money arrived
//   status: "refunded"      money went back — no package is owed
//   fulfillmentStatus       the OWNER'S OWN RECORDED ACKNOWLEDGMENT, by
//                           Sean's explicit design. Never evidence that
//                           anything physically shipped.
//   trackingNumber          a real shipping label was bought with real money.
//                           Not proof of delivery, and not the same as the
//                           owner having marked the order fulfilled.
//
// Conflating any two of these would have J4 accusing an owner of neglecting a
// customer whose parcel they posted on Tuesday. So this module keeps them as
// separate fields and never derives one from another.
//
// NO THRESHOLD, DELIBERATELY. Age is reported raw, in days. Nothing here calls
// an order "late" or "overdue" — shipping norms differ by business, and a
// threshold is a detector wearing a different hat. J4 reasons about the number
// in conversation.

/** One order the owner still owes a customer. */
export interface OutstandingOrder {
  /** Who is waiting. No shipping address, ever — it is not needed to answer. */
  buyerEmail: string;
  productName: string;
  orderedAt: string;
  /** Whole days since the order was placed. Computed, never estimated. */
  daysWaiting: number;
  /**
   * A real shipping label exists for this order. NOT delivery, and NOT the
   * owner having marked it fulfilled — an order can carry a label and still be
   * outstanding, which is exactly the case worth telling apart.
   */
  labelPurchased: boolean;
  carrier: string | null;
}

/** An unfulfilled order that is nonetheless not owed to anyone. */
export interface NotOwedOrder {
  productName: string;
  orderedAt: string;
  /** The payment status that takes it out of "owed" — named, never hidden. */
  paymentStatus: string;
}

export interface Obligations {
  /** Paid, unfulfilled, not refunded. Oldest first. */
  outstanding: OutstandingOrder[];
  outstandingCount: number;
  /**
   * Refunded and never fulfilled. Kept visible but strictly separate: the
   * money went back, so no package is owed. Never to be added to outstanding.
   */
  refundedUnfulfilledCount: number;
  /**
   * Unfulfilled with any other payment status (not paid, not refunded). Real,
   * counted, and deliberately not assumed to be owed — an unpaid order is not
   * an obligation, and a status this module has never seen is not one either.
   */
  otherUnfulfilledCount: number;
  otherUnfulfilledStatuses: string[];
  /**
   * getFulfillmentBreakdown's own numbers, carried through unchanged, so the
   * dashboard and J4 can never quote different totals. Note unfulfilledCount
   * counts EVERY unfulfilled order including refunded ones — it is not
   * outstandingCount, and the two must not be conflated.
   */
  fulfilledCount: number;
  unfulfilledCount: number;
  /** Null when nothing is outstanding — not 0, which would read as "shipped today". */
  oldestWaitingDays: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export interface OrderRow {
  productName: string;
  buyerEmail: string;
  status: string;
  fulfillmentStatus: string;
  trackingNumber: string | null;
  carrier: string | null;
  createdAt: Date;
}

/**
 * Sort real orders into what is owed and what only looks like it — pure.
 *
 * `now` is injected rather than read, so "days waiting" is a provable number
 * rather than something only observable against the wall clock.
 */
export function planObligations(params: {
  orders: OrderRow[];
  breakdown: { fulfilledCount: number; unfulfilledCount: number };
  now: Date;
}): Obligations {
  const { orders, breakdown, now } = params;

  const unfulfilled = orders.filter((o) => o.fulfillmentStatus === "unfulfilled");

  const outstanding: OutstandingOrder[] = unfulfilled
    .filter((o) => o.status === "paid")
    .map((o) => ({
      buyerEmail: o.buyerEmail,
      productName: o.productName,
      orderedAt: o.createdAt.toISOString(),
      daysWaiting: Math.max(0, Math.floor((now.getTime() - o.createdAt.getTime()) / DAY_MS)),
      // Presence of a real label, nothing more. Deliberately not folded into
      // fulfillmentStatus, and deliberately not called "shipped".
      labelPurchased: o.trackingNumber !== null,
      carrier: o.carrier,
    }))
    .sort((a, b) => b.daysWaiting - a.daysWaiting || a.orderedAt.localeCompare(b.orderedAt));

  const refundedUnfulfilled = unfulfilled.filter((o) => o.status === "refunded");
  const other = unfulfilled.filter((o) => o.status !== "paid" && o.status !== "refunded");

  return {
    outstanding,
    outstandingCount: outstanding.length,
    refundedUnfulfilledCount: refundedUnfulfilled.length,
    otherUnfulfilledCount: other.length,
    otherUnfulfilledStatuses: [...new Set(other.map((o) => o.status))].sort(),
    fulfilledCount: breakdown.fulfilledCount,
    unfulfilledCount: breakdown.unfulfilledCount,
    oldestWaitingDays: outstanding.length > 0 ? outstanding[0].daysWaiting : null,
  };
}

/**
 * The database-facing half. getFulfillmentBreakdown is reused unmodified, so
 * Analytics and J4 read the identical counts.
 */
export async function getObligations(storeId: string): Promise<Obligations> {
  const [orders, breakdown] = await Promise.all([
    prisma.order.findMany({
      where: { storeId },
      // Deliberately narrow. shippingAddress is never selected — answering
      // "who is waiting and how long" does not need where they live, and data
      // that is never read cannot leak into a prompt.
      select: {
        productName: true,
        buyerEmail: true,
        status: true,
        fulfillmentStatus: true,
        trackingNumber: true,
        carrier: true,
        createdAt: true,
      },
    }),
    getFulfillmentBreakdown(storeId),
  ]);

  return planObligations({ orders, breakdown, now: new Date() });
}
