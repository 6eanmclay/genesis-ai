import { withCorrelation } from "@/lib/observability/correlation";
import { recordDelivery, markProcessed, markFailed } from "./delivery";
import { recordSignal, SIGNAL_KINDS } from "@/lib/security/signals";

// ONE DELIVERY SYSTEM, HOWEVER MANY PROVIDERS.
//
// ============ THE AUDIT THAT SHAPED THIS (2026-08-30) ==================
//
// Zero of fourteen connectors implement IntegrationWebhooks. All three live
// handlers — Stripe, PayPal, EasyPost — are one-off routes that bypass the
// framework entirely, and each had grown its own answer to the same four
// questions: read the body once, verify before trusting, resolve which
// business it belongs to, and decide what a failure means to the provider.
//
// They answered those four WELL. The verification in each is correct and
// specific to a real provider contract, and none of it is rewritten here.
// What was missing was everything AROUND the handler: no record that a
// delivery arrived, no duplicate detection, no correlation, and no way to see
// somebody posting unsigned payloads at the endpoint.
//
// So this is the surround, not the contract. A route keeps its own verify and
// its own handler; it gains the audit trail, the correlation chain and the
// security signal by passing them through here.
//
// ============ WHAT IT DELIBERATELY DOES NOT DO ========================
//
// It does not make anything asynchronous. Stripe and PayPal move real money
// inline, in the request, and they still do — turning a payment side effect
// into a queued job is a decision with customer-visible consequences, not a
// tidying exercise. Where a handler genuinely wants durable retry it enqueues
// from inside itself, and the correlation id follows it there.
//
// It does not verify. Each provider's scheme is its own — Stripe's SDK, a
// PayPal API call against a per-store webhook id, an HMAC for EasyPost — and
// inventing a shared abstraction over three schemes we did not design would be
// a worse fit than the three that already work.

export interface WebhookVerdict {
  ok: boolean;
  /** The provider's own event id, when it offers one. Enables duplicate detection. */
  eventId?: string | null;
  /** Which business this belongs to, once known. */
  storeId?: string | null;
  /** Why it failed, for the rejected record. */
  error?: string;
}

export interface ReceiveInput {
  provider: string;
  rawBody: string;
  headers?: Record<string, string> | null;
  /**
   * Verify the signature and say what the delivery is.
   *
   * RUNS FIRST, ALWAYS. Nothing is recorded as received and no handler is
   * called until this returns ok, which is what makes "verify before
   * processing" structural rather than a convention each route remembers.
   */
  verify: () => Promise<WebhookVerdict> | WebhookVerdict;
  /**
   * Apply the delivery. Runs INLINE, in the request.
   *
   * Throwing means the provider should retry — most send a 5xx back into their
   * own retry schedule, which is the correct behaviour for a handler that is
   * idempotent, and every handler reachable from here is.
   */
  handle: (verdict: WebhookVerdict) => Promise<void>;
}

export type ReceiveOutcome =
  | { status: "processed"; duplicate: boolean; deliveryId: string | null }
  | { status: "rejected"; reason: string }
  | { status: "failed"; error: string; deliveryId: string | null };

/**
 * Take a delivery, write it down, and apply it.
 *
 * The ordering is the design: correlate, verify, record, handle, mark. Any
 * other order either trusts an unverified payload or loses the record of a
 * delivery that crashed the handler.
 */
export async function receiveWebhook(input: ReceiveInput): Promise<ReceiveOutcome> {
  // ============ THE DELIVERY OPENS A CHAIN ==========================
  //
  // Everything below — the delivery row, a rejection signal, the handler's
  // executions and outbound operations, and any job it enqueues — shares one
  // id from here. That is what turns "a webhook arrived" and "an order was
  // updated" from two facts near each other in time into one story.
  return withCorrelation({ origin: "webhook", surface: input.provider }, async () => {
    let verdict: WebhookVerdict;
    try {
      verdict = await input.verify();
    } catch (error) {
      // A verifier that throws on a hostile payload is itself a defect, but it
      // must never become a 500 a prober can use to map the surface.
      verdict = { ok: false, error: error instanceof Error ? error.message : "verifier threw" };
    }

    if (!verdict.ok) {
      // WRITTEN DOWN, NOT DROPPED. One bad signature is noise; a burst is a
      // rotated secret nobody updated, or somebody probing — and neither is
      // visible if the only trace is a 400 in a log that rolls over.
      await recordDelivery({
        provider: input.provider,
        rawBody: input.rawBody,
        signatureValid: false,
        externalEventId: verdict.eventId ?? null,
        headers: input.headers ?? null,
      });
      await recordSignal({
        kind: SIGNAL_KINDS.webhookUnsigned,
        severity: "warning",
        actorKind: "provider",
        surface: `webhook:${input.provider}`,
        detail: { provider: input.provider, bytes: input.rawBody.length },
      });
      return { status: "rejected", reason: verdict.error ?? "invalid signature" };
    }

    // Recorded BEFORE the handler, so a delivery that crashes it is still on
    // file and can be replayed from exactly what the provider sent.
    const delivery = await recordDelivery({
      provider: input.provider,
      rawBody: input.rawBody,
      signatureValid: true,
      externalEventId: verdict.eventId ?? null,
      storeId: verdict.storeId ?? null,
      headers: input.headers ?? null,
    });

    try {
      await input.handle(verdict);
      await markProcessed(delivery?.id ?? null, verdict.storeId ?? null);
      return {
        status: "processed",
        // A provider retrying an event we already hold is a recognisable fact
        // rather than a second unit of work. The handler still runs — it is
        // idempotent, and refusing to run it would break a legitimate replay
        // of an event whose first attempt failed.
        duplicate: delivery?.duplicate ?? false,
        deliveryId: delivery?.id ?? null,
      };
    } catch (error) {
      await markFailed(delivery?.id ?? null, error);
      return {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        deliveryId: delivery?.id ?? null,
      };
    }
  });
}
