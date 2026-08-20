import { prisma } from "@/lib/prisma";
import { PERMISSIONS } from "@/lib/permissions";
import type { Executable } from "../executable";
import { EXECUTION_ACTIONS } from "../actions";

interface OrderMetadata {
  orderId: string;
  fulfillmentStatus: string;
}

interface ToggleFulfilledInput {
  orderId: string;
  // `currentlyFulfilled` used to live here, supplied by the caller. Removed
  // 2026-08-20 — the executable reads the real state itself now, and a field
  // nobody reads is a trap for whoever next assumes it is authoritative.
}

// Owner-experience milestone — manual-only fulfillment tracking (Sean's
// explicit choice, 2026-08-02): this flips a local status flag, exactly
// like toggleProductActiveExecutable. It never places a real order with a
// fulfillment connector — that's a deliberate, later Phase 2 capability.
export const toggleOrderFulfilledExecutable: Executable<ToggleFulfilledInput, OrderMetadata> = {
  action: EXECUTION_ACTIONS.ORDER_TOGGLE_FULFILLED,
  requiredPermission: PERMISSIONS.ORDERS_MANAGE,
  async run(input, ctx) {
    // The CURRENT state is read here, scoped to this store, rather than taken
    // from the caller (2026-08-20).
    //
    // It used to arrive as `currentlyFulfilled`, computed by the action from a
    // read it had done earlier — a check-then-act with a page render in the
    // middle. Two tabs, or a stale page, and the toggle flips against a state
    // that has since changed.
    const order = await prisma.order.findFirst({
      where: { id: input.orderId, storeId: ctx.storeId },
      select: { id: true, fulfillmentStatus: true, trackingNumber: true, carrier: true, status: true },
    });
    if (!order) throw new Error("Order not found");

    const currentlyFulfilled = order.fulfillmentStatus === "fulfilled";
    const nowFulfilled = !currentlyFulfilled;

    // A REFUNDED ORDER MUST NOT BE MARKED FULFILLED.
    //
    // The money went back; committing to send the goods anyway is a decision
    // nobody made on purpose. Un-marking one that shipped BEFORE the refund is
    // still allowed below — that is a real sequence (goods sent, money later
    // returned) and the owner may legitimately want to correct the flag.
    if (nowFulfilled && order.status === "refunded") {
      throw new Error("This order was refunded — it can't be marked as fulfilled.");
    }

    // A PARCEL IN THE POST CANNOT BECOME UNFULFILLED.
    //
    // Buying a label marks the order fulfilled, records tracking, and emails
    // the customer that it shipped. Un-marking it afterwards left the order
    // showing as still needing fulfilment while the parcel was already gone and
    // the buyer had tracking for it — an invitation to ship the same order
    // twice. The label is the authoritative signal, so it wins.
    if (!nowFulfilled && order.trackingNumber) {
      throw new Error(
        `This order already shipped — ${order.carrier ?? "the carrier"} has tracking ${order.trackingNumber}. ` +
          `It can't be marked unfulfilled.`
      );
    }

    // Conditional on the state just read, so a concurrent toggle is detected
    // rather than silently overwritten by whichever request lands last.
    const updated = await prisma.order.updateMany({
      where: {
        id: input.orderId,
        storeId: ctx.storeId,
        fulfillmentStatus: currentlyFulfilled ? "fulfilled" : "unfulfilled",
      },
      data: {
        fulfillmentStatus: nowFulfilled ? "fulfilled" : "unfulfilled",
        fulfilledAt: nowFulfilled ? new Date() : null,
      },
    });
    if (updated.count === 0) {
      throw new Error("This order's status changed while you were looking at it — reload and try again.");
    }

    return {
      message: nowFulfilled ? `Order marked as fulfilled` : `Order marked as unfulfilled`,
      metadata: { orderId: order.id, fulfillmentStatus: nowFulfilled ? "fulfilled" : "unfulfilled" },
    };
  },
};
