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
  currentlyFulfilled: boolean;
}

// Owner-experience milestone — manual-only fulfillment tracking (Sean's
// explicit choice, 2026-08-02): this flips a local status flag, exactly
// like toggleProductActiveExecutable. It never places a real order with a
// fulfillment connector — that's a deliberate, later Phase 2 capability.
export const toggleOrderFulfilledExecutable: Executable<ToggleFulfilledInput, OrderMetadata> = {
  action: EXECUTION_ACTIONS.ORDER_TOGGLE_FULFILLED,
  requiredPermission: PERMISSIONS.ORDERS_MANAGE,
  async run(input, ctx) {
    const nowFulfilled = !input.currentlyFulfilled;
    const order = await prisma.order.update({
      where: { id: input.orderId, storeId: ctx.storeId },
      data: {
        fulfillmentStatus: nowFulfilled ? "fulfilled" : "unfulfilled",
        fulfilledAt: nowFulfilled ? new Date() : null,
      },
    });
    return {
      message: nowFulfilled ? `Order marked as fulfilled` : `Order marked as unfulfilled`,
      metadata: { orderId: order.id, fulfillmentStatus: order.fulfillmentStatus },
    };
  },
};
