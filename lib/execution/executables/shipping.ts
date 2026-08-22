import { prisma } from "@/lib/prisma";
import { PERMISSIONS } from "@/lib/permissions";
import type { Executable, ExecutionContext } from "../executable";
import { EXECUTION_ACTIONS } from "../actions";
import { decryptCredentials } from "@/lib/integrations/credentials";
import type { EasyPostCredentials } from "@/lib/integrations/easypost";
import type { OrderShippingAddress } from "@/lib/orders/shippingAddress";
import {
  buyLabelViaEasyPost,
  ServiceUnavailableError,
  type LabelBuyer,
  type StoreOriginAddress,
} from "@/lib/shipping/labelPurchase";
import {
  notifyCustomerShipped,
  labelPurchaseMessage,
  type ShippedNotification,
} from "@/lib/orders/notifyCustomerShipped";

interface PurchaseShippingLabelInput {
  orderId: string;
  weightOz: number;
  lengthIn?: number;
  widthIn?: number;
  heightIn?: number;
}

interface ShippingLabelMetadata {
  orderId: string;
  carrier: string;
  trackingNumber: string;
  shippingCostInCents: number;
}

/**
 * Buy a real shipping label for a real order.
 *
 * Split from the Executable below (2026-08-20) so `buy` can be supplied, the
 * same shape and for the same reason as lib/orders/orderConfirmation.ts's
 * injectable sender: the carrier round trip needs an EasyPost credential this
 * environment does not have, and everything around it — the guards, the claim,
 * which rate is bought, what is recorded, what the customer is told — must not
 * go unproven just because the one blocked step sits in the middle of it.
 *
 * The executable is a straight delegation to this. There is no behaviour in it.
 */
export async function purchaseLabelForOrder(
  input: PurchaseShippingLabelInput,
  ctx: ExecutionContext,
  buy: LabelBuyer = buyLabelViaEasyPost
): Promise<{ message: string; metadata: ShippingLabelMetadata }> {
  const order = await prisma.order.findUnique({ where: { id: input.orderId, storeId: ctx.storeId } });
  if (!order) throw new Error("Order not found");
  if (order.trackingNumber) throw new Error("This order already has a shipping label");

  // A REFUNDED ORDER MUST NOT COST THE OWNER POSTAGE (2026-08-20).
  //
  // Nothing checked payment status here, so a fully refunded order could
  // still have a real label bought for it: the customer has their money back
  // AND the goods are posted to them at the owner's expense. Straight out the
  // door with nothing coming back.
  //
  // Deliberately blocking only a FULL refund (status === "refunded"), which is
  // the only refund this codebase currently models — see the charge.refunded
  // handler's own note on partial refunds.
  if (order.status === "refunded") {
    throw new Error(
      "This order was refunded — buying a label would post the goods at your expense after the customer got their money back."
    );
  }

  const toAddress = order.shippingAddress as unknown as OrderShippingAddress | null;
  if (!toAddress) {
    throw new Error("This order has no shipping address on file — a label can't be bought without one");
  }

  const store = await prisma.store.findUnique({ where: { id: ctx.storeId } });
  const returnAddress = store?.returnAddress as unknown as StoreOriginAddress | null;
  if (!returnAddress) {
    throw new Error(
      "Add your ship-from address in Settings before buying a shipping label — carriers need a real return address."
    );
  }

  const integration = await prisma.storeIntegration.findUnique({
    where: { storeId_provider: { storeId: ctx.storeId, provider: "EASYPOST" } },
  });
  const credentials = integration?.credentials
    ? decryptCredentials<EasyPostCredentials>(integration.credentials)
    : null;
  if (!credentials?.apiKey) {
    throw new Error("Connect shipping in Payments/Connections before buying a label");
  }

  if (!input.weightOz || input.weightOz <= 0) {
    throw new Error("Enter a real package weight (in ounces) to get a rate");
  }

  // CLAIM BEFORE SPENDING (2026-08-20).
  //
  // The `order.trackingNumber` guard above is only as good as the instant it
  // ran: trackingNumber is written AFTER the label is bought, and everything
  // between here and the purchase is awaited. Two concurrent submits both
  // passed that check and both reached EasyPost — real postage, paid twice,
  // for one parcel.
  //
  // The conditional update matches only while no purchase is in flight, so
  // exactly one caller proceeds. Released on any failure below, because an
  // order stuck permanently claimed could never be shipped at all.
  const labelClaim = await prisma.order.updateMany({
    where: { id: order.id, storeId: ctx.storeId, labelClaimedAt: null, trackingNumber: null },
    data: { labelClaimedAt: new Date() },
  });
  if (labelClaim.count === 0) {
    throw new Error("A shipping label for this order is already being bought");
  }

  let updated: Awaited<ReturnType<typeof prisma.order.update>>;
  let purchased: Awaited<ReturnType<LabelBuyer>>;
  try {
    // BUY WHAT THE CUSTOMER PAID FOR (2026-08-20).
    //
    // This used to filter to USPS and buy the cheapest rate, full stop —
    // `Order.selectedShippingService` was written by the webhook and then read
    // by nobody. A customer who chose and paid for Priority Mail Express got
    // Ground Advantage: the delivery promise made to them was quietly broken,
    // and the difference went into the store's margin without anyone deciding
    // it. Passing the selection down means it is bought; where the carrier will
    // not sell it, the purchase REFUSES rather than substituting something
    // slower. See chooseRate() for why refusing is the correct half of the fix.
    purchased = await buy(credentials.apiKey, {
      to: toAddress,
      from: returnAddress,
      parcel: {
        weightOz: input.weightOz,
        lengthIn: input.lengthIn,
        widthIn: input.widthIn,
        heightIn: input.heightIn,
      },
      selected: {
        carrier: order.selectedShippingCarrier,
        service: order.selectedShippingService,
      },
    });

    updated = await prisma.order.update({
      where: { id: order.id, storeId: ctx.storeId },
      data: {
        carrier: purchased.carrier,
        trackingNumber: purchased.trackingNumber,
        trackingUrl: purchased.trackingUrl,
        labelUrl: purchased.labelUrl,
        shippingCostInCents: purchased.costInCents,
        fulfillmentStatus: "fulfilled",
        fulfilledAt: new Date(),
      },
    });
  } catch (error) {
    // Released only while no label actually landed. If the purchase succeeded
    // and the write failed, trackingNumber is still null here and the claim
    // lifts — but the guard above will not re-run a purchase for an order
    // that already has one, so the two conditions together are what keep a
    // retry safe rather than expensive.
    await prisma.order
      .updateMany({
        where: { id: order.id, storeId: ctx.storeId, trackingNumber: null },
        data: { labelClaimedAt: null },
      })
      .catch(() => {});
    // Rethrown unchanged. A ServiceUnavailableError already reads as something
    // an owner can act on; wrapping it would bury the only useful sentence.
    throw error;
  }

  // Real customer notification (Sean: "...tracking number → shipped
  // order... customer notification"). Never blocks or fails this
  // executable — the label is already bought with real money by this
  // point, so an email hiccup must never look like the label purchase
  // itself failed.
  //
  // But it is no longer SILENT either (2026-08-20). Whether the customer was
  // actually told now reaches the owner's own result message, because on a
  // store with no email configured — every store today — the buyer heard
  // nothing and only the owner can put that right.
  // Claimed before sending, released if the send fails — the same shape as
  // the order confirmation, and for the same reason. The label-purchase guard
  // above (`if (order.trackingNumber) throw`) is a check-then-act, so two
  // concurrent submits could both reach here; without this the buyer would
  // get two "your order shipped" emails for one shipment.
  const claimed = await prisma.order.updateMany({
    where: { id: order.id, storeId: ctx.storeId, shipmentNotifiedAt: null },
    data: { shipmentNotifiedAt: new Date() },
  });

  const notification: ShippedNotification =
    claimed.count === 0
      ? { notified: false, reason: "already_notified" }
      : await notifyCustomerShipped({
          to: order.buyerEmail,
          productName: order.productName,
          carrier: updated.carrier ?? "Unknown carrier",
          trackingNumber: updated.trackingNumber!,
          trackingUrl: updated.trackingUrl,
        });

  if (claimed.count > 0 && !notification.notified) {
    // Release, so buying a label again (or a later retry) can still tell them.
    await prisma.order
      .update({ where: { id: order.id, storeId: ctx.storeId }, data: { shipmentNotifiedAt: null } })
      .catch(() => {});
  }

  return {
    message: labelPurchaseMessage({
      carrier: updated.carrier ?? "Unknown carrier",
      trackingNumber: updated.trackingNumber!,
      notification,
    }),
    metadata: {
      orderId: order.id,
      carrier: updated.carrier ?? "Unknown carrier",
      trackingNumber: updated.trackingNumber!,
      shippingCostInCents: purchased.costInCents,
    },
  };
}

export { ServiceUnavailableError };

// Priority 2 (shipping, 2026-08-09) — "Paid order → shipping address →
// shipping/label workflow → USPS → tracking number → shipped order"
// (Sean, VISION.md's own Cubit & Coil Live sequencing). A real, owner-
// triggered EasyPost purchase — never automatic on payment, matching
// toggleOrderFulfilledExecutable's own "manual, owner-triggered" precedent,
// now doubly true since this spends real money on postage.
//
// V1 bought the cheapest USPS rate and nothing else, which was right while
// nothing else existed. Once checkout let the customer choose and pay for a
// service, "cheapest" became a way of not honouring it — see
// purchaseLabelForOrder above.
export const purchaseShippingLabelExecutable: Executable<PurchaseShippingLabelInput, ShippingLabelMetadata> = {
  action: EXECUTION_ACTIONS.ORDER_PURCHASE_SHIPPING_LABEL,
  requiredPermission: PERMISSIONS.ORDERS_MANAGE,
  run: (input, ctx) => purchaseLabelForOrder(input, ctx),
};
