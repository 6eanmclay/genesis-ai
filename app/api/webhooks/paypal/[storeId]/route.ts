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
import { withCorrelation } from "@/lib/observability/correlation";
import { recordDelivery, markProcessed, markFailed } from "@/lib/webhooks/delivery";
import { recordSignal, SIGNAL_KINDS } from "@/lib/security/signals";
import { handlePaypalEvent } from "@/lib/payments/paypalEvent";

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

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ storeId: string }> }
): Promise<Response> {
  const { storeId } = await params;
  return withCorrelation({ origin: "webhook", surface: "PAYPAL" }, async () => {
    // Same correction as the Stripe route: marking a delivery processed the
    // moment its signature verified recorded RECEIPT and called it HANDLING,
    // so a refund that failed to reconcile still read "processed".
    const tracked: { deliveryId: string | null } = { deliveryId: null };
    try {
      const response = await handlePaypalWebhook(request, storeId, tracked);
      if (response.status >= 200 && response.status < 300) {
        await markProcessed(tracked.deliveryId, storeId);
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

async function handlePaypalWebhook(
  request: NextRequest,
  storeId: string,
  tracked: { deliveryId: string | null },
): Promise<Response> {

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
    // WRITTEN DOWN, NOT DROPPED. Anyone can post to any store's URL — the
    // signature is the proof — so a burst of failures here is exactly the
    // shape worth being able to see.
    await recordDelivery({ provider: "PAYPAL", rawBody, signatureValid: false, storeId });
    await recordSignal({
      kind: SIGNAL_KINDS.webhookUnsigned, severity: "warning", actorKind: "provider",
      storeId, surface: "webhook:PAYPAL", detail: { provider: "PAYPAL", storeId },
    });
    return new Response("Invalid signature", { status: 400 });
  }

  // Recorded verbatim, before anything acts on it, with PayPal's own event id
  // so a redelivery is recognisable rather than a second unit of work.
  const delivery = await recordDelivery({
    provider: "PAYPAL",
    rawBody,
    signatureValid: true,
    storeId,
    externalEventId: (() => {
      try {
        const parsed = JSON.parse(rawBody) as { id?: unknown };
        return typeof parsed.id === "string" ? parsed.id : null;
      } catch {
        // Verified but unparseable. A fabricated id would make two different
        // deliveries look like one retry, so null is the honest answer.
        return null;
      }
    })(),
  });
  tracked.deliveryId = delivery?.id ?? null;

  // Everything below this line is trusted. Nothing above it was.

  // ============ THE LINE WHERE TRUST BEGINS ======================
  //
  // The half below used to continue inline, which meant a legitimately
  // received refund could never be replayed: PayPal verification is a live
  // API call against a transmission id and timestamp, so it cannot be
  // repeated from a stored body at all. It now lives in
  // lib/payments/paypalEvent.ts with two callers — this route, which has
  // just verified, and replay, which refuses any delivery whose signature
  // did not verify when it arrived.
  return handlePaypalEvent(rawBody, storeId);
}
