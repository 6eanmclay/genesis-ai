import { carriageProviderFor } from "@/lib/carriage/registry";
import {
  isValidEasyPostSignature,
  applyShipmentUpdate,
  reportIngestionFailure,
} from "@/lib/carriage/delivery";
import type { IntegrationWebhooks, WebhookVerification } from "./types";

// EASYPOST'S SIDE OF THE WEBHOOK CONTRACT.
//
// ============ THE FIRST CONNECTOR TO IMPLEMENT IT (2026-08-30) =========
//
// IntegrationWebhooks has existed for months and no connector implemented it;
// all three live handlers were one-off routes bypassing the framework. This is
// the first real implementation, and it is EasyPost rather than Stripe on
// purpose: its handler is small, self-contained and moves no money, so the
// pattern can be proven end to end without refactoring a payment path to do it.
//
// Stripe and PayPal deliberately stay as routes for now. Their handlers create
// orders and reconcile payments across six hundred lines, and moving that here
// would be a money-path refactor with no demonstrated need — the delivery
// record, correlation and duplicate detection they were missing are supplied by
// the shared pipeline without touching any of it.
//
// ============ WHAT BELONGS IN A CONNECTOR AND WHAT DOES NOT ===========
//
// This file is the PROVIDER CONTRACT: how EasyPost signs a request, what its
// payload means, which of its events matter. Everything generic — recording the
// delivery, detecting a duplicate, opening a correlation chain, reporting an
// unsigned payload — lives in lib/webhooks/pipeline.ts and is not repeated per
// provider. Adding the next provider is implementing this file, not that one.

export const easypostWebhooks: IntegrationWebhooks = {
  /**
   * Verify the HMAC over the exact bytes sent.
   *
   * Never throws on a hostile payload — a verifier that does is a way to
   * distinguish "malformed" from "wrong signature" from the outside, which is
   * information a prober should not be given.
   */
  verify(rawBody: string, headers: Headers): WebhookVerification {
    const secret = process.env.EASYPOST_WEBHOOK_SECRET;
    // No secret means no request can be authenticated, and accepting
    // unauthenticated delivery updates is strictly worse than accepting none.
    if (!secret) return { ok: false, error: "EASYPOST_WEBHOOK_SECRET is not configured" };

    try {
      const ok = isValidEasyPostSignature({
        rawBody,
        header: headers.get("x-hmac-signature"),
        secret,
      });
      if (!ok) return { ok: false, error: "invalid signature" };
    } catch {
      return { ok: false, error: "signature verification failed" };
    }

    // EasyPost's payload carries an event id on some kinds and not others.
    // Read where it exists and left null where it does not — a fabricated id
    // would make two different deliveries look like one retry.
    let eventId: string | undefined;
    try {
      const parsed = JSON.parse(rawBody) as { id?: unknown };
      if (typeof parsed.id === "string") eventId = parsed.id;
    } catch {
      // Verified but unparseable is a real anomaly and is handled in handle();
      // it is not a verification failure.
    }

    // NO externalAccountId. EasyPost is configured platform-wide rather than
    // per-store, so a delivery is resolved to a business by matching the
    // tracker to an order, not by an account id. Claiming one we do not have
    // would make the generic route resolve the wrong store.
    return { ok: true, eventId };
  },

  /**
   * Apply a tracker update.
   *
   * ACCEPTS QUIETLY WHEN THERE IS NOTHING TO DO. One EasyPost account can carry
   * parcels this platform did not create, and an error would put the carrier
   * into a retry loop over a parcel that will never match.
   */
  async handle(_storeId: string, rawBody: string): Promise<void> {
    let payload: { description?: string; result?: unknown };
    try {
      payload = JSON.parse(rawBody) as { description?: string; result?: unknown };
    } catch (error) {
      // Genuinely from the carrier, yet unparseable. Reported, because that is
      // an anomaly worth seeing, and accepted, because a retry would deliver
      // the same bytes.
      reportIngestionFailure(error, { stage: "parse" });
      return;
    }

    // EasyPost sends every event type to one endpoint. Tracker updates are the
    // only kind consumed; the rest are acknowledged and ignored rather than
    // treated as errors.
    if (typeof payload.description !== "string" || !payload.description.startsWith("tracker.")) {
      return;
    }

    const provider = carriageProviderFor("EASYPOST");
    if (!provider?.toShipment) {
      reportIngestionFailure(new Error("no carriage provider could map this payload"), {
        description: payload.description,
      });
      return;
    }

    try {
      // The provider owns the vocabulary. Nothing here inspects a carrier
      // status string itself — that is what made the mapper worth reusing.
      const shipment = provider.toShipment(payload.result, null);
      await applyShipmentUpdate(shipment);
    } catch (error) {
      reportIngestionFailure(error, { description: payload.description });
    }
  },
};
