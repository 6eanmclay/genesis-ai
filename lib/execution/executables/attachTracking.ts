import { prisma } from "@/lib/prisma";
import { verifiedUnless, type VerificationOutcome } from "../verification";
import { PERMISSIONS } from "@/lib/permissions";
import type { Executable } from "../executable";
import { EXECUTION_ACTIONS } from "../actions";
import { notifyCustomerShipped } from "@/lib/orders/notifyCustomerShipped";
import { reportIssue } from "@/lib/observability/reportIssue";

// ATTACHING A TRACKING NUMBER THE MERCHANT ALREADY HAS.
//
// The only way an order could ever get tracking was purchasing a label through
// a carrier API, which needs a provider account this deployment does not have.
// So every paid order in production has sat at "paid" with no tracking, and the
// buyer has never been told anything — not because the chain is broken, but
// because it had exactly one entrance and that entrance was locked.
//
// This is the other entrance, and it is not a lesser one. A merchant who buys
// postage at the counter, or on USPS.com, or through any tool they already use,
// comes back with a tracking number on a label in their hand. Taking that number
// is a complete fulfilment path — it is how a great many small businesses
// actually ship — and it needs no provider integration at all.
//
// WHAT THIS DELIBERATELY DOES NOT DO. It does not buy postage, quote a rate, or
// claim a carrier relationship. It records a fact the merchant supplies, the
// same way `stateFact` records what an owner says about their business. The
// number is theirs; Genesis is not asserting it is valid, only that they gave
// it.

export interface AttachTrackingInput {
  orderId: string;
  trackingNumber: string;
  /** What the merchant says carried it. Free text — they know, we do not. */
  carrier?: string;
}

interface AttachTrackingMetadata {
  orderId: string;
  trackingNumber: string;
  carrier: string;
  /** Whether the buyer was actually emailed, which needs email configured. */
  customerNotified: boolean;
}

/** USPS's own public tracking page. */
const USPS_TRACKING_URL = "https://tools.usps.com/go/TrackConfirmAction?tLabels=";

/**
 * A tracking URL, when we can honestly build one.
 *
 * Only for carriers whose public tracking URL is a stable, documented pattern.
 * A guessed URL that 404s is worse than no link: the buyer clicks it, sees
 * nothing, and concludes the parcel does not exist.
 */
export function trackingUrlFor(carrier: string, trackingNumber: string): string | null {
  const normalized = carrier.trim().toUpperCase();
  if (normalized === "USPS") return `${USPS_TRACKING_URL}${encodeURIComponent(trackingNumber)}`;
  return null;
}

/**
 * What a tracking number may look like before we will store it.
 *
 * Deliberately loose. Carriers use wildly different formats and a strict
 * pattern would reject real numbers — the failure mode of a merchant unable to
 * record a real shipment is far worse than storing something malformed. This
 * only catches the obvious: empty, or something no carrier issues.
 */
export function isPlausibleTrackingNumber(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 6 || trimmed.length > 40) return false;
  // Carriers use letters, digits, and occasionally spaces or hyphens. Anything
  // else is a scan that picked up the wrong thing.
  return /^[A-Za-z0-9][A-Za-z0-9 -]*[A-Za-z0-9]$/.test(trimmed);
}

export const attachTrackingExecutable: Executable<AttachTrackingInput, AttachTrackingMetadata> = {
  action: EXECUTION_ACTIONS.ORDER_ATTACH_TRACKING,
  requiredPermission: PERMISSIONS.ORDERS_MANAGE,

  async run(input, ctx) {
    const trackingNumber = input.trackingNumber.trim();
    const carrier = (input.carrier ?? "USPS").trim() || "USPS";

    if (!isPlausibleTrackingNumber(trackingNumber)) {
      throw new Error(
        "That does not look like a tracking number. Check the label and try again, or type it in by hand."
      );
    }

    const order = await prisma.order.findFirst({
      where: { id: input.orderId, storeId: ctx.storeId },
      select: { id: true, trackingNumber: true, buyerEmail: true, productName: true },
    });
    if (!order) throw new Error("Order not found");

    // ALREADY SHIPPED IS NOT A CONFLICT TO RESOLVE SILENTLY. The buyer may
    // already be watching the first number. Replacing it would strand them, so
    // this refuses and says which number is on file — the same rule the label
    // purchase applies for the same reason.
    if (order.trackingNumber) {
      throw new Error(
        `This order already has tracking ${order.trackingNumber}. Genesis will not replace it — ` +
          `the buyer may already be following it.`
      );
    }

    // CLAIMED, NOT CHECKED-THEN-WRITTEN. The read above is check-then-act, so
    // two submissions racing (a double-tap, a scan and a paste) could both pass
    // it. The updateMany matches only while trackingNumber is still null, so
    // exactly one wins and the loser sees the refusal above on its next read.
    const claimed = await prisma.order.updateMany({
      where: { id: input.orderId, storeId: ctx.storeId, trackingNumber: null },
      data: {
        trackingNumber,
        carrier,
        trackingUrl: trackingUrlFor(carrier, trackingNumber),
        fulfillmentStatus: "fulfilled",
        fulfilledAt: new Date(),
      },
    });
    if (claimed.count === 0) {
      throw new Error("This order was given a tracking number a moment ago.");
    }

    // THE BUYER IS TOLD, and this is the point of the whole milestone.
    //
    // Claimed before sending and released if the send fails — the SAME shape as
    // the label-purchase path, deliberately, because the same hazard applies:
    // the guard above is a check-then-act and two submissions could both reach
    // here, which would email the buyer twice about one shipment.
    let customerNotified = false;
    try {
      const claimedNotify = await prisma.order.updateMany({
        where: { id: order.id, storeId: ctx.storeId, shipmentNotifiedAt: null },
        data: { shipmentNotifiedAt: new Date() },
      });
      if (claimedNotify.count > 0) {
        const notification = await notifyCustomerShipped({
          to: order.buyerEmail,
          productName: order.productName,
          carrier,
          trackingNumber,
          trackingUrl: trackingUrlFor(carrier, trackingNumber),
        });
        customerNotified = notification.notified;
        if (!notification.notified) {
          // Released, so a later retry can still tell them.
          await prisma.order
            .update({ where: { id: order.id, storeId: ctx.storeId }, data: { shipmentNotifiedAt: null } })
            .catch(() => {});
        }
      }
    } catch (error) {
      // Never rethrown: the tracking number is already recorded and the parcel
      // is really in the post. An email failure must not look like the shipment
      // did not happen.
      reportIssue(`order ${order.id} shipped but the buyer could not be told`, error, {
        subsystem: "email",
        stage: "order.attachTracking",
        storeId: ctx.storeId,
      });
    }

    return {
      message: customerNotified
        ? `Tracking ${trackingNumber} added. The customer has been emailed.`
        : // SAID PLAINLY. Email is not configured on this deployment, so the
          // buyer heard nothing — and the merchant is the only one who can tell
          // them. Reporting success here would be a lie the merchant acts on.
          `Tracking ${trackingNumber} added. The customer was NOT emailed — send them the number yourself.`,
      metadata: { orderId: order.id, trackingNumber, carrier, customerNotified },
    };
  },

  // CLASS C — a row that must now carry exactly what was recorded.
  async verify(input, ctx, metadata): Promise<VerificationOutcome> {
    if (!metadata) {
      return { state: "failed", mismatches: ["the run recorded no tracking number"] };
    }
    const order = await prisma.order.findFirst({
      where: { id: input.orderId, storeId: ctx.storeId },
      select: { trackingNumber: true, carrier: true, fulfillmentStatus: true, fulfilledAt: true },
    });
    if (!order) return { state: "failed", mismatches: ["order: no such order after the write"] };

    const mismatches: string[] = [];
    if (order.trackingNumber !== metadata.trackingNumber) {
      mismatches.push(
        `order.trackingNumber: expected ${metadata.trackingNumber}, stored ${order.trackingNumber}`
      );
    }
    if (order.carrier !== metadata.carrier) {
      mismatches.push(`order.carrier: expected ${metadata.carrier}, stored ${order.carrier}`);
    }
    // A tracked order that still reads unfulfilled is a half-applied write, and
    // the owner would see a shipped parcel sitting in their to-do list.
    if (order.fulfillmentStatus !== "fulfilled") {
      mismatches.push(`order.fulfillmentStatus: tracking was attached but it reads ${order.fulfillmentStatus}`);
    }
    if (!order.fulfilledAt) {
      mismatches.push("order.fulfilledAt: fulfilled, but no timestamp was recorded");
    }
    return verifiedUnless(mismatches);
  },
};
