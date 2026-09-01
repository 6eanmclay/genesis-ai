import { prisma } from "@/lib/prisma";
import { PERMISSIONS } from "@/lib/permissions";
import type { Executable } from "../executable";
import type { VerificationOutcome } from "../verification";
import { EXECUTION_ACTIONS } from "../actions";
import { isPlausibleTrackingNumber, trackingUrlFor } from "./attachTracking";

// FIXING A TRACKING NUMBER THAT WAS TYPED WRONG.
//
// ============ WHY THE REFUSAL WAS RIGHT, AND INCOMPLETE (2026-09-01) ===
//
// attachTracking refuses to replace an existing number, and says why: "the
// buyer may already be following it." That is a real hazard and the refusal
// stays exactly as it is for the case it was written for.
//
// It is not true of the case that actually happens. A merchant types a
// tracking number by hand from a counter receipt, transposes two digits, and
// the number is now permanent — with nobody having been told anything, because
// this deployment has never had an email provider. The guard protected a buyer
// who does not exist yet and stranded the merchant who does.
//
// ============ SO THE CONDITION IS THE BUYER, NOT THE COLUMN ===========
//
// A correction is allowed only while nothing external has committed to the old
// number:
//
//   shipmentNotifiedAt   the buyer WAS told. They may be refreshing that
//                        number right now, and silently swapping it would
//                        strand them — which is the harm the original refusal
//                        exists to prevent, and it still does.
//
//   labelUrl             a real label was bought. The carrier issued that
//                        number and holds the parcel under it; a hand-typed
//                        correction would make Genesis disagree with the
//                        carrier, and the carrier is right.
//
// Neither is a state a typo can reach, which is the point: the merchant can fix
// their own mistake right up until the moment somebody else is relying on it.
//
// ============ AND IT IS A SEPARATE VERB ===============================
//
// Not a flag on attachTracking. Adding a number and replacing one are different
// intents with different risks, and folding them together means a resubmitted
// form can silently overwrite. Somebody correcting a number has to say so.

export interface CorrectTrackingInput {
  orderId: string;
  trackingNumber: string;
  carrier?: string;
}

export interface CorrectTrackingMetadata {
  orderId: string;
  trackingNumber: string;
  carrier: string;
  /** What it was, so the change is legible in the execution log. */
  previousTrackingNumber: string;
  previousCarrier: string | null;
}

export const correctTrackingExecutable: Executable<CorrectTrackingInput, CorrectTrackingMetadata> = {
  action: EXECUTION_ACTIONS.ORDER_CORRECT_TRACKING,
  requiredPermission: PERMISSIONS.ORDERS_MANAGE,

  async run(input, ctx) {
    const trackingNumber = input.trackingNumber.trim();
    if (!isPlausibleTrackingNumber(trackingNumber)) {
      throw new Error("That does not look like a tracking number. Check it and try again.");
    }

    const order = await prisma.order.findFirst({
      where: { id: input.orderId, storeId: ctx.storeId },
      select: {
        id: true, trackingNumber: true, carrier: true,
        labelUrl: true, shipmentNotifiedAt: true,
      },
    });
    if (!order) throw new Error("Order not found");

    // ---- the three refusals, each with the reason the merchant needs ----
    if (!order.trackingNumber) {
      throw new Error("This order has no tracking number yet — add one rather than correcting one.");
    }
    if (order.labelUrl) {
      throw new Error(
        "A shipping label was bought for this order, so the carrier issued that tracking number. " +
          "It cannot be corrected here.",
      );
    }
    if (order.shipmentNotifiedAt) {
      throw new Error(
        `The customer has already been sent tracking ${order.trackingNumber}. ` +
          "Genesis will not change it underneath them — contact them with the new number instead.",
      );
    }
    if (order.trackingNumber === trackingNumber && (order.carrier ?? "") === (input.carrier?.trim() ?? order.carrier ?? "")) {
      throw new Error("That is already the tracking number on this order.");
    }

    const previousTrackingNumber = order.trackingNumber;
    const previousCarrier = order.carrier;
    const carrier = input.carrier?.trim() || order.carrier || "USPS";

    // CONDITIONAL ON WHAT WAS READ, like every other write in this family. Two
    // corrections racing must not interleave into a number neither person
    // typed, and the loser is told the row moved rather than silently winning.
    const changed = await prisma.order.updateMany({
      where: {
        id: input.orderId,
        storeId: ctx.storeId,
        trackingNumber: previousTrackingNumber,
        // Re-asserted in the WHERE, not just checked above: the read and the
        // write are separated by awaits, and a label bought in between must
        // make this lose rather than overwrite the carrier's own number.
        labelUrl: null,
        shipmentNotifiedAt: null,
      },
      data: {
        trackingNumber,
        carrier,
        trackingUrl: trackingUrlFor(carrier, trackingNumber),
      },
    });
    if (changed.count === 0) {
      throw new Error("This order changed while you were editing it — reload and try again.");
    }

    // ============ FULFILMENT IS NOT TOUCHED ========================
    //
    // attachTracking marks an order fulfilled because attaching a number is the
    // merchant saying it went out. A correction says the number was wrong, not
    // that the parcel un-shipped, so fulfillmentStatus and fulfilledAt are left
    // exactly as they are.
    return {
      message:
        `Tracking corrected to ${trackingNumber}. ` +
        "The customer has not been told anything, so nothing needs undoing with them.",
      metadata: {
        orderId: order.id, trackingNumber, carrier,
        previousTrackingNumber, previousCarrier,
      },
    };
  },

  // CLASS C — the row must now carry exactly what was recorded, and must NOT
  // still carry what it replaced.
  async verify(input, ctx, metadata): Promise<VerificationOutcome> {
    const order = await prisma.order.findFirst({
      where: { id: input.orderId, storeId: ctx.storeId },
      select: { trackingNumber: true, carrier: true, trackingUrl: true },
    });
    if (!order) return { state: "failed", mismatches: ["order: no such order after the write"] };

    const mismatches: string[] = [];
    if (order.trackingNumber !== metadata?.trackingNumber) {
      mismatches.push(`order.trackingNumber: expected ${metadata?.trackingNumber}, stored ${order.trackingNumber}`);
    }
    if (order.carrier !== metadata?.carrier) {
      mismatches.push(`order.carrier: expected ${metadata?.carrier}, stored ${order.carrier}`);
    }
    // The old number must be gone, not merely the new one present — a write
    // that appended rather than replaced would satisfy the check above.
    if (metadata && order.trackingNumber === metadata.previousTrackingNumber) {
      mismatches.push("order.trackingNumber: still the number this was meant to replace");
    }
    const expectedUrl = metadata ? trackingUrlFor(metadata.carrier, metadata.trackingNumber) : null;
    if (order.trackingUrl !== expectedUrl) {
      mismatches.push(`order.trackingUrl: expected ${expectedUrl}, stored ${order.trackingUrl}`);
    }
    return mismatches.length === 0 ? { state: "verified" } : { state: "failed", mismatches };
  },
};
