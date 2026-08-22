import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { reportIssue } from "@/lib/observability/reportIssue";
import type { Shipment } from "@/lib/businessModel/entities";

// RECEIVING WHAT THE CARRIER SAYS, AND WRITING IT DOWN.
//
// The half of delivery tracking that did not exist. mapTrackerToShipment has
// always been able to turn a carrier tracker into a canonical Shipment — pure,
// covered by its own suite — and nothing ever called it: no route received an
// update and no column held the result. This is that ingestion.
//
// NOTHING IS EVER INFERRED. An order is delivered because the carrier said so,
// never because enough days passed. A parcel with no scans keeps null
// timestamps rather than borrowing the order date, which is the rule
// mapTrackerToShipment already holds and this preserves on the way to the
// database.

/**
 * Verify an EasyPost webhook signature.
 *
 * EasyPost signs the raw body with HMAC-SHA256 using a secret configured
 * alongside the webhook, and sends it as `hmac-sha256-hex=<hex>`.
 *
 * TIMING-SAFE, and not as ceremony: a plain `===` on a hex digest leaks how
 * many leading characters were right, one request at a time, which is enough
 * to forge a signature given patience. `timingSafeEqual` is the only reason
 * this function is longer than one line.
 */
export function isValidEasyPostSignature(params: {
  rawBody: string;
  header: string | null;
  secret: string;
}): boolean {
  if (!params.header || !params.secret) return false;

  // The header carries an algorithm prefix. Anything other than the one we
  // compute is refused rather than best-guessed — an unrecognised algorithm is
  // not a signature we can check.
  const [algorithm, provided] = params.header.split("=");
  if (algorithm !== "hmac-sha256-hex" || !provided) return false;

  const expected = crypto.createHmac("sha256", params.secret).update(params.rawBody, "utf8").digest("hex");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided.trim(), "utf8");
  // Length must be compared first: timingSafeEqual throws on a mismatch, and a
  // throw here would be a 500 on a forged request rather than a refusal.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export type DeliveryUpdateOutcome =
  | { updated: true; orderId: string; delivered: boolean }
  /** No order carries this tracking number — not ours, or not ours any more. */
  | { updated: false; reason: "no_matching_order" }
  /** The payload carried no tracking code, so there is nothing to match on. */
  | { updated: false; reason: "no_tracking_code" }
  /** This update is older than what the order already knows. */
  | { updated: false; reason: "stale" };

/**
 * Apply one canonical shipment to the order it belongs to.
 *
 * MATCHED BY TRACKING NUMBER, not by an id in the payload. The tracking number
 * is the only thing both sides genuinely share — a carrier does not know
 * Genesis order ids — and it is already stored on the order by the label
 * purchase that created it.
 *
 * OUT-OF-ORDER UPDATES ARE REFUSED, because webhooks arrive out of order and
 * "delivered" followed by a re-delivered "in_transit" would walk an order
 * backwards out of its final state in front of the owner.
 */
export async function applyShipmentUpdate(shipment: Shipment): Promise<DeliveryUpdateOutcome> {
  const trackingNumber = shipment.trackingCode?.trim();
  if (!trackingNumber) return { updated: false, reason: "no_tracking_code" };

  const order = await prisma.order.findFirst({
    where: { trackingNumber },
    select: { id: true, storeId: true, lastScanAt: true, deliveredAt: true },
  });
  if (!order) return { updated: false, reason: "no_matching_order" };

  const scanAt = shipment.lastScanAt ? new Date(shipment.lastScanAt) : null;
  const deliveredAt = shipment.deliveredAt ? new Date(shipment.deliveredAt) : null;

  // Older than what we already have. A carrier replaying an earlier scan must
  // not undo a later one.
  if (scanAt && order.lastScanAt && scanAt < order.lastScanAt) {
    return { updated: false, reason: "stale" };
  }
  // And delivery is terminal for this purpose: nothing after it may clear it.
  if (order.deliveredAt && !deliveredAt) {
    return { updated: false, reason: "stale" };
  }

  await prisma.order.update({
    where: { id: order.id, storeId: order.storeId },
    data: {
      shipmentStatus: shipment.status,
      // Only ever set, never cleared — see the stale check above.
      ...(deliveredAt ? { deliveredAt } : {}),
      ...(scanAt ? { lastScanAt: scanAt } : {}),
    },
  });

  return { updated: true, orderId: order.id, delivered: shipment.isDelivered };
}

/**
 * Report an ingestion failure without failing the webhook.
 *
 * A carrier that gets a 500 retries, and retrying a payload we cannot use
 * achieves nothing but noise. The failure is reported to an operator and the
 * carrier is told we received it.
 */
export function reportIngestionFailure(
  error: unknown,
  detail: Record<string, string | number | boolean | null | undefined>
): void {
  reportIssue("a carrier tracking update could not be applied", error, {
    subsystem: "integrations",
    stage: "carriage.tracking_update",
    extra: detail,
  });
}
