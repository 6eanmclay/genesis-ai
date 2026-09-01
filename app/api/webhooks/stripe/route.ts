import { sendOrderConfirmation } from "@/lib/orders/orderConfirmation";
import { notifyOwnerOfSale } from "@/lib/orders/notifyOwnerOfSale";
import { notifyCustomerRefunded } from "@/lib/orders/refundNotification";
import { isPermanentOrderFailure } from "@/lib/orders/orderFailure";
import { checkWebhookSecret } from "@/lib/observability/webhookConfig";
import { reportIssue } from "@/lib/observability/reportIssue";
import { randomUUID } from "crypto";
import Stripe from "stripe";
import { after } from "next/server";
import { recordExecution } from "@/lib/execution/log";
import { EXECUTION_ACTIONS } from "@/lib/execution/actions";
import { CURRENT_EXECUTION_SCHEMA_VERSION } from "@/lib/execution/types";
import { prisma } from "@/lib/prisma";
import { formatMoney } from "@/lib/money";
import { runDeterministicObservationSweep } from "@/lib/dashboard/genesisObservations";
import { measureDueMeasurements } from "@/lib/dashboard/postExecutionMeasurement";
import { writeBusinessEvents } from "@/lib/intelligence/businessEvents";
import { mapOrdersToTransactions, internalTransactionId } from "@/lib/businessModel/internalMapper";
import { fromStripeShippingDetails } from "@/lib/orders/shippingAddress";
import { parseCheckoutShipping } from "@/lib/shipping/checkoutShipping";
import { parseDiscountMetadata } from "@/lib/promotions/checkoutDiscount";
import { loadDraft, draftTotalMismatch } from "@/lib/bag/checkoutDraft";
import {
  linesFromDraft,
  linesFromStripe,
  noLines,
  primaryNameFor,
  primaryProductId,
  totalQuantity,
  type RecoveredLines,
} from "@/lib/bag/orderLines";
import { resolveWebhookStore } from "@/lib/orders/webhookStore";
import { withCorrelation } from "@/lib/observability/correlation";
import { recordDelivery, markProcessed, markFailed } from "@/lib/webhooks/delivery";
import { recordSignal, SIGNAL_KINDS } from "@/lib/security/signals";
import { handleStripeEvent } from "@/lib/payments/stripeEvent";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export async function POST(request: Request): Promise<Response> {
  const body = await request.text();
  const headers = request.headers;
  return withCorrelation({ origin: "webhook", surface: "STRIPE" }, async () => {
    // ============ THE OUTCOME IS KNOWN OUT HERE, NOT IN THERE =======
    //
    // The first version of this marked the delivery processed immediately after
    // the signature verified — which recorded RECEIPT and called it HANDLING.
    // A delivery whose order creation then failed would have read "processed"
    // in the health report, which is the audit trail telling a lie about the
    // one thing it exists to be honest about.
    //
    // The handler has two success returns and five hundred lines between them,
    // so the id is carried out through a holder rather than extracted — the
    // alternative is a money-path refactor to fix a bookkeeping bug.
    const tracked: { deliveryId: string | null } = { deliveryId: null };
    try {
      const response = await handleStripeWebhook(body, headers, tracked);
      if (response.status >= 200 && response.status < 300) {
        await markProcessed(tracked.deliveryId);
      } else {
        await markFailed(tracked.deliveryId, new Error(`handler returned ${response.status}`));
      }
      return response;
    } catch (error) {
      await markFailed(tracked.deliveryId, error);
      throw error;
    }
  });
}

async function handleStripeWebhook(
  body: string,
  headers: Headers,
  tracked: { deliveryId: string | null },
): Promise<Response> {
  const signature = headers.get("stripe-signature");

  // Read per request, not at module load: a config check that runs once when
  // the lambda cold-starts cannot report anything useful, and the value can
  // change between deploys.
  const configured = checkWebhookSecret(process.env.STRIPE_WEBHOOK_SECRET, "STRIPE_WEBHOOK_SECRET");
  if (!configured.ok) {
    // 500, NOT 400. 400 tells Stripe the request is permanently bad and it
    // stops retrying, which turns a missing environment variable into real
    // payments that never became orders. See lib/observability/webhookConfig.ts.
    reportIssue(configured.reason, new Error("STRIPE_WEBHOOK_SECRET is not set"), {
      subsystem: "payments",
      stage: "stripe.webhook.config",
    });
    return new Response("Webhook not configured", { status: configured.status });
  }

  if (!signature) {
    await recordDelivery({ provider: "STRIPE", rawBody: body, signatureValid: false });
    await recordSignal({
      kind: SIGNAL_KINDS.webhookUnsigned, severity: "warning", actorKind: "provider",
      surface: "webhook:STRIPE", detail: { provider: "STRIPE", reason: "no signature header" },
    });
    return new Response("Missing signature", { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, configured.secret);
  } catch {
    // WRITTEN DOWN, NOT DROPPED. One is noise; a burst is a rotated secret
    // nobody updated, or somebody probing the endpoint.
    await recordDelivery({ provider: "STRIPE", rawBody: body, signatureValid: false });
    await recordSignal({
      kind: SIGNAL_KINDS.webhookUnsigned, severity: "warning", actorKind: "provider",
      surface: "webhook:STRIPE", detail: { provider: "STRIPE", reason: "signature did not verify" },
    });
    return new Response("Invalid signature", { status: 400 });
  }

  // Recorded before anything acts on it, verbatim, with Stripe's own event id
  // so a redelivery is a recognisable fact rather than a second unit of work.
  const delivery = await recordDelivery({
    provider: "STRIPE",
    rawBody: body,
    signatureValid: true,
    externalEventId: event.id,
  });
  // Handed back to POST, which is the only place that knows how this ended.
  tracked.deliveryId = delivery?.id ?? null;

  // ============ RECORDED, OR NOT ACTED ON AT ALL (2026-09-01) =====
  //
  // recordDelivery returns null when it could not write — it reports and
  // swallows, which is right for a helper and wrong to ignore here. This line
  // used to be the whole handling of that: the id became null and the handler
  // ran anyway, so an event could be ACTED ON with nothing recording that it
  // arrived. That is precisely the invariant the comment above claims, and it
  // was not enforced.
  //
  // It is reachable. A partial deploy where WebhookDelivery does not exist yet,
  // a lock on that one table, or a lost race whose winner lookup also fails,
  // all produce a null while the rest of the database works perfectly well —
  // and the handler would then create the order, return 200, and mark nothing.
  // markProcessed(null) is a no-op, so the audit trail would have no memory of
  // an event that moved real money.
  //
  // 500, so Stripe retries. It holds failed events for days and redelivers, so
  // the cost of refusing is a delayed order; the cost of proceeding is an order
  // whose arrival nothing can evidence and which replay can never reach.
  if (!delivery) {
    reportIssue(
      "a Stripe webhook could not be recorded, so it was not handled",
      new Error("recordDelivery returned null"),
      { subsystem: "payments", stage: "stripe.webhook.unrecorded" },
    );
    return new Response("Could not record delivery", { status: 500 });
  }

  // ============ THE LINE WHERE TRUST BEGINS ======================
  //
  // Above: nothing is trusted. Below: it is Stripe's word, proven.
  //
  // The handling used to continue inline for five hundred lines, which
  // meant a legitimately received delivery could never be replayed — a
  // stored signature is expired by definition, so anything that must
  // re-verify to run can only ever run once. The half below this line now
  // lives in lib/payments/stripeEvent.ts and is called by two callers: this
  // route, which has just verified, and replay, which refuses any delivery
  // whose signature did not verify when it arrived.
  return handleStripeEvent(event);
}
