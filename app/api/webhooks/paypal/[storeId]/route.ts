import { NextRequest } from "next/server";
import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import { decryptCredentials } from "@/lib/integrations/credentials";
import {
  getPaypalAccessToken,
  verifyPaypalWebhook,
  type PaypalCredentials,
} from "@/lib/integrations/paypal";
import { reportIssue } from "@/lib/observability/reportIssue";
import { recordExecution } from "@/lib/execution/log";
import { CURRENT_EXECUTION_SCHEMA_VERSION } from "@/lib/execution/types";
import { EXECUTION_ACTIONS } from "@/lib/execution/actions";

// PayPal refunds — the counterpart to the Stripe rail's charge.refunded.
//
// Until this existed, a refunded PayPal sale kept counting as revenue and its
// goods could still be posted at the owner's expense, because every consumer of
// that decision reads Order.status and nothing ever set it (COMPLIANCE.md §41).
//
// THE TRUST MODEL, and it is the whole route. The store id in the path is a
// CLAIM — anyone can post to any store's URL. The signature is the PROOF: the
// event is verified against the webhook id stored in THAT store's own
// credentials, so a forged delivery naming any store fails, and a genuine
// delivery for store A can never be applied to store B. Same shape as the Stripe
// rail, where `event.account` is the claim and the signature is the proof.
//
// The subscription is created in the merchant's own PayPal app at connect time
// (lib/integrations/paypal.ts), so no merchant has to paste a webhook id, and a
// store connected before that existed has no webhook — its integration says so
// on itself rather than silently dropping refunds.
//
// Hand-built rather than declared through IntegrationConnector.webhooks(), and
// deliberately so — same as the Stripe money webhook beside it. That contract
// gets its idempotency from persistSyncedRecords' unique key on business
// records; this handler mutates Order.status, which is money state, not a synced
// record. Pushing a refund through a business-data sync contract would buy a
// shared shape at the cost of the guarantee that actually matters here.

/** How long after a refund a missing order is still plausibly in flight. */
const COMMIT_RACE_WINDOW_MS = 10 * 60 * 1000;

interface PaypalRefundResource {
  id?: string;
  status?: string;
  amount?: { value?: string; currency_code?: string };
  seller_payable_breakdown?: { total_refunded_amount?: { value?: string } };
  links?: { rel?: string; href?: string }[];
  capture_id?: string;
}

/**
 * Which capture was refunded? — PayPal's refund resource does not carry the
 * capture id as a field, it carries a link up to it. Parsed rather than assumed,
 * with `capture_id` accepted too because some payload shapes do include it.
 */
export function paypalCaptureIdFromRefund(resource: PaypalRefundResource): string | null {
  if (resource.capture_id) return resource.capture_id;
  const up = resource.links?.find((l) => l.rel === "up" && l.href?.includes("/payments/captures/"));
  const id = up?.href?.split("/payments/captures/")[1]?.split(/[/?#]/)[0];
  return id && id.length > 0 ? id : null;
}

function toCents(value: string | undefined): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : null;
}

/**
 * How much of this order has now been refunded, in cents.
 *
 * `total_refunded_amount` is cumulative and is what makes a second partial
 * refund that completes the total read as a full one; `amount` is just this
 * refund. Preferring the cumulative figure is the difference between two halves
 * adding up and two halves each looking partial forever.
 */
export function refundedCents(resource: PaypalRefundResource): number | null {
  return toCents(resource.seller_payable_breakdown?.total_refunded_amount?.value) ?? toCents(resource.amount?.value);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ storeId: string }> }
) {
  const { storeId } = await params;

  // Read once, as text. The signature covers these exact bytes.
  const rawBody = await request.text();

  const integration = await prisma.storeIntegration.findUnique({
    where: { storeId_provider: { storeId, provider: "PAYPAL" } },
  });
  const credentials = integration?.credentials
    ? decryptCredentials<PaypalCredentials>(integration.credentials)
    : null;

  if (!credentials?.webhookId || !credentials.clientId || !credentials.clientSecret) {
    // Nothing to check the signature against, so this cannot be judged at all —
    // and "I cannot check this" is a different answer from "this is forged".
    // 404 rather than 400: PayPal keeps retrying, so a store that reconnects
    // still receives the backlog, exactly as lib/observability/webhookConfig.ts
    // argues for the Stripe endpoint.
    return new Response("No PayPal refund webhook is configured for this store", { status: 404 });
  }

  let accessToken: string;
  try {
    accessToken = await getPaypalAccessToken(
      credentials.clientId,
      credentials.clientSecret,
      credentials.environment
    );
  } catch (error) {
    reportIssue(`could not authenticate with PayPal to verify a refund webhook`, error, {
      subsystem: "payments",
      stage: "paypal.webhook.auth",
      storeId,
    });
    // Ours to fix, and a retry genuinely recovers it.
    return new Response("Could not verify", { status: 503 });
  }

  const verified = await verifyPaypalWebhook({
    accessToken,
    environment: credentials.environment,
    webhookId: credentials.webhookId,
    rawBody,
    headers: {
      authAlgo: request.headers.get("paypal-auth-algo"),
      certUrl: request.headers.get("paypal-cert-url"),
      transmissionId: request.headers.get("paypal-transmission-id"),
      transmissionSig: request.headers.get("paypal-transmission-sig"),
      transmissionTime: request.headers.get("paypal-transmission-time"),
    },
  }).catch(() => false);

  if (!verified) {
    // Permanent. Nothing about retrying an unverifiable delivery makes it
    // verifiable, and this is the only branch that should ever say 400.
    return new Response("Invalid signature", { status: 400 });
  }

  // Everything below this line is trusted. Nothing above it was.
  let event: { event_type?: string; create_time?: string; resource?: PaypalRefundResource };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response("Malformed event", { status: 400 });
  }

  if (event.event_type !== "PAYMENT.CAPTURE.REFUNDED" && event.event_type !== "PAYMENT.CAPTURE.REVERSED") {
    // Subscribed to nothing else, but a merchant editing the subscription in
    // PayPal could send more. Acknowledged, not retried.
    return new Response("OK", { status: 200 });
  }

  const resource = event.resource ?? {};
  const captureId = paypalCaptureIdFromRefund(resource);
  if (!captureId) {
    reportIssue(`a verified PayPal refund named no capture`, null, {
      subsystem: "payments",
      stage: "paypal.webhook.capture_id",
      storeId,
      extra: { eventType: event.event_type },
    });
    // Retrying an identical payload cannot produce a capture id.
    return new Response("OK", { status: 200 });
  }

  // Scoped to the store the signature just proved this event belongs to, so a
  // verified refund can only ever touch that store's own orders.
  const order = await prisma.order.findFirst({
    where: { storeId, paymentProvider: "PAYPAL", externalPaymentId: captureId },
    select: { id: true, amountInCents: true, status: true },
  });

  if (!order) {
    // THE COMMIT RACE. The capture route writes the order after PayPal has taken
    // the money, so a refund issued moments later can genuinely arrive first.
    // Inside that window a retry is the fix; outside it, nothing is coming and
    // retrying for three days only delays somebody looking at it.
    const createdAt = event.create_time ? Date.parse(event.create_time) : Number.NaN;
    const age = Number.isFinite(createdAt) ? Date.now() - createdAt : Number.POSITIVE_INFINITY;
    if (age < COMMIT_RACE_WINDOW_MS) {
      return new Response("Order not recorded yet", { status: 503 });
    }

    await recordExecution({
      executionId: randomUUID(),
      action: EXECUTION_ACTIONS.CHECKOUT_PAYPAL_REFUND_UNAPPLIED,
      status: "FAILED",
      verified: false,
      message: `PayPal refunded capture ${captureId}, but no order in this store matches it. Reconcile this in PayPal — the money has left your account.`,
      retryable: false,
      actorType: "USER",
      actorId: null,
      storeId,
      storeDraftId: null,
      schemaVersion: CURRENT_EXECUTION_SCHEMA_VERSION,
      timestamp: new Date(),
      metadata: { captureId, eventType: event.event_type },
    }).catch((error: unknown) => {
      reportIssue(`could not record an unapplied PayPal refund for ${captureId}`, error, {
        subsystem: "payments",
        stage: "paypal.webhook.persist",
        storeId,
        extra: { captureId },
      });
    });
    return new Response("OK", { status: 200 });
  }

  // Only a genuinely FULL refund flips status, matching the Stripe rail exactly.
  // A partial refund does not change what the owner still has to ship, and
  // relabelling a substantially-paid order "refunded" would mislead them.
  // Partial refunds remain a named, deliberate gap — see COMPLIANCE.md's
  // close-out, where they are a product decision rather than a defect.
  const refunded = refundedCents(resource);
  if (refunded === null || refunded < order.amountInCents) {
    return new Response("OK", { status: 200 });
  }

  // Claim-then-act rather than the Stripe rail's check-then-act: PayPal
  // redelivers, and two deliveries racing here would otherwise both read "paid"
  // and both write. The conditional update makes the second a genuine no-op.
  await prisma.order.updateMany({
    where: { id: order.id, storeId, status: { not: "refunded" } },
    data: { status: "refunded" },
  });

  return new Response("OK", { status: 200 });
}
