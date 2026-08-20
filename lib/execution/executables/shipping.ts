import EasyPost from "@easypost/api";
import { prisma } from "@/lib/prisma";
import { PERMISSIONS } from "@/lib/permissions";
import type { Executable } from "../executable";
import { EXECUTION_ACTIONS } from "../actions";
import { decryptCredentials } from "@/lib/integrations/credentials";
import type { EasyPostCredentials } from "@/lib/integrations/easypost";
import type { OrderShippingAddress } from "@/lib/orders/shippingAddress";
import {
  notifyCustomerShipped,
  labelPurchaseMessage,
  type ShippedNotification,
} from "@/lib/orders/notifyCustomerShipped";

interface StoreReturnAddress {
  name: string;
  phone: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string | null;
  postalCode: string;
  country: string;
}

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

function toEasyPostAddress(address: OrderShippingAddress, name?: string | null) {
  return {
    name: name ?? address.name ?? undefined,
    street1: address.line1,
    street2: address.line2 ?? undefined,
    city: address.city,
    state: address.state ?? undefined,
    zip: address.postalCode,
    country: address.country,
  };
}

// Priority 2 (shipping, 2026-08-09) — "Paid order → shipping address →
// shipping/label workflow → USPS → tracking number → shipped order"
// (Sean, VISION.md's own Cubit & Coil Live sequencing). A real, owner-
// triggered EasyPost purchase — never automatic on payment, matching
// toggleOrderFulfilledExecutable's own "manual, owner-triggered" precedent,
// now doubly true since this spends real money on postage. V1 deliberately
// simple (Sean's own repeated "start simple" principle throughout this
// session): the owner enters the parcel's real weight/dimensions at
// purchase time, this buys the single lowest real USPS rate available —
// no rate-shopping UI, no other carriers. A real, later, separate addition
// if ever needed, not a V1 requirement.
export const purchaseShippingLabelExecutable: Executable<PurchaseShippingLabelInput, ShippingLabelMetadata> = {
  action: EXECUTION_ACTIONS.ORDER_PURCHASE_SHIPPING_LABEL,
  requiredPermission: PERMISSIONS.ORDERS_MANAGE,
  async run(input, ctx) {
    const order = await prisma.order.findUnique({ where: { id: input.orderId, storeId: ctx.storeId } });
    if (!order) throw new Error("Order not found");
    if (order.trackingNumber) throw new Error("This order already has a shipping label");

    const toAddress = order.shippingAddress as unknown as OrderShippingAddress | null;
    if (!toAddress) {
      throw new Error("This order has no shipping address on file — a label can't be bought without one");
    }

    const store = await prisma.store.findUnique({ where: { id: ctx.storeId } });
    const returnAddress = store?.returnAddress as unknown as StoreReturnAddress | null;
    if (!returnAddress) {
      throw new Error(
        "Add your ship-from address in Settings before buying a shipping label — USPS needs a real return address."
      );
    }

    const integration = await prisma.storeIntegration.findUnique({
      where: { storeId_provider: { storeId: ctx.storeId, provider: "EASYPOST" } },
    });
    const credentials = integration?.credentials
      ? decryptCredentials<EasyPostCredentials>(integration.credentials)
      : null;
    if (!credentials?.apiKey) {
      throw new Error("Connect USPS Shipping (via EasyPost) in Payments/Connections before buying a label");
    }

    if (!input.weightOz || input.weightOz <= 0) {
      throw new Error("Enter a real package weight (in ounces) to get a rate");
    }

    const client = new EasyPost(credentials.apiKey);

    const shipment = await client.Shipment.create({
      to_address: toEasyPostAddress(toAddress),
      from_address: {
        name: returnAddress.name,
        phone: returnAddress.phone,
        street1: returnAddress.line1,
        street2: returnAddress.line2 ?? undefined,
        city: returnAddress.city,
        state: returnAddress.state ?? undefined,
        zip: returnAddress.postalCode,
        country: returnAddress.country,
      },
      parcel: {
        weight: input.weightOz,
        length: input.lengthIn,
        width: input.widthIn,
        height: input.heightIn,
      },
    });

    const uspsRates = shipment.rates.filter((r) => r.carrier === "USPS");
    if (uspsRates.length === 0) {
      throw new Error(
        shipment.messages?.length
          ? `USPS returned no rates for this shipment: ${shipment.messages.map((m) => m.message).join("; ")}`
          : "USPS returned no rates for this shipment — check the addresses and package weight"
      );
    }
    const lowestUspsRate = uspsRates.reduce((lowest, r) => (parseFloat(r.rate) < parseFloat(lowest.rate) ? r : lowest));

    const bought = await client.Shipment.buy(shipment.id, lowestUspsRate);

    const shippingCostInCents = Math.round(parseFloat(lowestUspsRate.rate) * 100);

    const updated = await prisma.order.update({
      where: { id: order.id, storeId: ctx.storeId },
      data: {
        carrier: bought.selected_rate?.carrier ?? "USPS",
        trackingNumber: bought.tracking_code,
        trackingUrl: bought.tracker?.public_url ?? null,
        labelUrl: bought.postage_label?.label_url ?? null,
        shippingCostInCents,
        fulfillmentStatus: "fulfilled",
        fulfilledAt: new Date(),
      },
    });

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
            carrier: updated.carrier ?? "USPS",
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
        carrier: updated.carrier ?? "USPS",
        trackingNumber: updated.trackingNumber!,
        notification,
      }),
      metadata: {
        orderId: order.id,
        carrier: updated.carrier ?? "USPS",
        trackingNumber: updated.trackingNumber!,
        shippingCostInCents,
      },
    };
  },
};
