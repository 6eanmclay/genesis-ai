// WHERE AN ORDER IS, AS ONE WORD.
//
// PURE, AND IN ITS OWN FILE ON PURPOSE. This is rendered by OrdersList, which
// is a CLIENT component, so it must not reach anything server-only. It lived
// beside the tracker ingestion for about ten minutes, and importing that file
// from the client pulled prisma and node:crypto into the browser bundle and
// broke the Orders page outright. Nothing here imports anything at all, which
// is the property that keeps it safe to render.

/**
 * Where an order is, as one word an owner can read.
 *
 * DERIVED, NEVER STORED, so it cannot drift from the fields it reads. Every
 * stage below is knowable from something real:
 *
 *   refunded   — the payment was reversed
 *   delivered  — the carrier said so
 *   shipped    — a label exists, so the parcel is genuinely in the post
 *   processing — the owner marked it fulfilled without buying a label here
 *   paid       — money arrived and nothing has happened since
 *
 * There is deliberately NO "new" stage. Every Order row in this system is
 * created by a completed payment, so an unpaid order has never existed — and a
 * stage that can never occur reads as a real one and quietly misleads.
 */
export type OrderStage = "paid" | "processing" | "shipped" | "delivered" | "refunded";

export function stageOf(order: {
  status: string;
  fulfillmentStatus: string;
  trackingNumber: string | null;
  deliveredAt: Date | null;
}): OrderStage {
  if (order.status === "refunded") return "refunded";
  if (order.deliveredAt) return "delivered";
  if (order.trackingNumber) return "shipped";
  if (order.fulfillmentStatus === "fulfilled") return "processing";
  return "paid";
}

/** What each stage says on screen. Owner's terms, never the system's. */
export const STAGE_LABEL: Record<OrderStage, string> = {
  paid: "Paid",
  processing: "Being prepared",
  shipped: "On its way",
  delivered: "Delivered",
  refunded: "Refunded",
};
