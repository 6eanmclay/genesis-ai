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
import { runDeterministicObservationSweep } from "@/lib/dashboard/genesisObservations";
import { measureDueMeasurements } from "@/lib/dashboard/postExecutionMeasurement";
import { writeBusinessEvents } from "@/lib/intelligence/businessEvents";
import { mapOrdersToTransactions, internalTransactionId } from "@/lib/businessModel/internalMapper";
import { fromStripeShippingDetails } from "@/lib/orders/shippingAddress";
import { parseCheckoutShipping } from "@/lib/shipping/checkoutShipping";
import { resolveWebhookStore } from "@/lib/orders/webhookStore";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);


export async function POST(request: Request) {
  const body = await request.text();
  const signature = request.headers.get("stripe-signature");

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
    return new Response("Missing signature", { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, configured.secret);
  } catch {
    return new Response("Invalid signature", { status: 400 });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const productId = session.metadata?.productId;

    // `event.account` is set when this event came from a connected
    // account's own activity (a store using its connected Stripe account,
    // not the platform-wide key). Metadata on the session is set by our
    // own createCheckoutSession action — but a connected merchant holds an
    // API-key-equivalent access token for their own account and could call
    // Stripe directly, so metadata alone isn't trustworthy for connected
    // events. `event.account` is controlled by Stripe, not the merchant,
    // so for connected events it's the source of truth for which store
    // this belongs to; metadata is only trusted for platform-key events
    // (no event.account), which we control end-to-end ourselves.
    //
    // Real bug found via live testing: externalAccountId has no unique
    // constraint (nothing stops two different stores from connecting the
    // same underlying Stripe account — an owner running more than one
    // store is a real, non-adversarial case), so findFirst-by-
    // externalAccountId-alone could resolve to the wrong store, or Stripe's
    // return order could differ from creation order. metadata.storeId is
    // now used to disambiguate, but only after confirming — via that
    // store's OWN stored externalAccountId, not the merchant's say-so —
    // that it really matches this event.account. That keeps the original
    // trust boundary intact (a forged metadata.storeId still can't claim
    // an event for an account it isn't genuinely connected to) while fixing
    // the ambiguity for stores that legitimately share one Stripe account.
    // The decision itself lives in lib/orders/webhookStore.ts so it can be
    // attacked directly with forged events — see verify-webhook-store.ts. The
    // rules are unchanged; only the lookups happen here.
    const metadataStoreId = session.metadata?.storeId;
    const claimed =
      event.account && metadataStoreId
        ? await prisma.storeIntegration.findUnique({
            where: { storeId_provider: { storeId: metadataStoreId, provider: "STRIPE" } },
            select: { storeId: true, externalAccountId: true },
          })
        : null;
    const byAccount = event.account
      ? await prisma.storeIntegration.findFirst({
          where: { provider: "STRIPE", externalAccountId: event.account },
          select: { storeId: true },
        })
      : null;

    const storeId =
      resolveWebhookStore({
        eventAccount: event.account,
        metadataStoreId,
        claimed,
        byAccount,
      }).storeId ?? undefined;

    if (!storeId || !productId) {
      console.error("[stripe webhook] could not resolve order target", {
        sessionId: session.id,
        account: event.account ?? null,
        metadataStoreId: metadataStoreId ?? null,
        productId: productId ?? null,
      });

      // Real money has arrived and no Order can be written for it. Until
      // 2026-08-20 the console line above was the ONLY trace: the customer got
      // their receipt from Stripe, the owner saw nothing at all, and Stripe got
      // a 200 so it never retried.
      //
      // When the store resolved, the owner gets a durable, visible record. When
      // it did not, there is genuinely no store to attach one to — a session
      // from an account we cannot match to any connection — and the console
      // line is the honest limit of what can be recorded. Stated rather than
      // quietly accepted.
      if (storeId) {
        try {
          await recordExecution({
            executionId: randomUUID(),
            action: EXECUTION_ACTIONS.CHECKOUT_STRIPE_UNRECORDED,
            status: "FAILED",
            verified: false,
            message:
              `A payment completed in Stripe (session ${session.id}) but no order could be created — ` +
              `the checkout did not carry a product. Reconcile this in Stripe before assuming it is not a real sale.`,
            retryable: false,
            actorType: "USER",
            actorId: null,
            storeId,
            storeDraftId: null,
            schemaVersion: CURRENT_EXECUTION_SCHEMA_VERSION,
            timestamp: new Date(),
            metadata: { sessionId: session.id, amountTotal: session.amount_total ?? null },
          });
        } catch (error) {
          reportIssue("could not record an unmatched payment", error, {
            subsystem: "payments",
            stage: "stripe.unrecorded.persist",
            storeId,
            extra: { sessionId: session.id },
          });
        }
      }
    }

    if (storeId && productId) {
      // Scoped to the store this event was resolved to (2026-08-20). The
      // lookup used to be by bare id, so a session carrying another store's
      // productId would have put THAT store's product name on this order. The
      // order is still created when the product is missing — the money is real
      // whatever the catalogue says — it just records an honest "Unknown
      // product" rather than a name borrowed from somewhere else.
      const product = await prisma.product.findFirst({
        where: { id: productId, storeId },
      });

      // Idempotent: Stripe can redeliver the same event more than once. An
      // existence check (rather than inferring "was this new" from upsert's
      // return value) inside the same transaction as the Order write means
      // the Order and its BusinessEvent commit together or not at all — see
      // PHASE1_DESIGN.md section 4. A retry that finds an existing Order is
      // a genuine no-op, exactly like the upsert this replaced.
      // Wrapped 2026-08-20, after reproducing the failure it existed to allow.
      //
      // A PLATFORM-key event takes storeId straight from metadata, unvalidated.
      // If the store was deleted between checkout and delivery, order.create
      // violates the foreign key and that threw straight out of POST — Next
      // answers 500, Stripe retries for days against something that can never
      // succeed, then gives up. A real payment, no order, and no record.
      //
      // The split below is the whole point. A PERMANENT failure must be
      // acknowledged, because retrying it is only a slower way to lose the same
      // sale. A TRANSIENT one must NOT be, because a retry is exactly what
      // recovers it.
      try {
      await prisma.$transaction(async (tx) => {
        const existing = await tx.order.findUnique({
          where: { paymentProvider_externalOrderId: { paymentProvider: "STRIPE", externalOrderId: session.id } },
        });
        if (existing) return;

        // Null for every checkout that did not go through the shipping step,
        // which is most of them — the parser returns honest nulls rather than
        // defaults, so nothing below changes for those.
        const chosenShipping = parseCheckoutShipping(session.metadata);

        const order = await tx.order.create({
          data: {
            storeId,
            // Only linked when the product genuinely exists in THIS store.
            //
            // This said `productId` unconditionally, and the comment above
            // promised the order would still be created with "Unknown product"
            // when the catalogue had moved on. It could not: Order.productId is
            // a foreign key, so naming a product that had been deleted violated
            // it and the whole order was lost — money taken, nothing recorded.
            //
            // Found 2026-08-20 by the first end-to-end run of this branch
            // through a real server (scripts/verify-order-webhook-live.ts). The
            // column is nullable and the relation is onDelete: SetNull, so an
            // order without a product was always the intended shape; the write
            // simply never honoured it.
            productId: product?.id ?? null,
            productName: product?.name ?? "Unknown product",
            amountInCents: session.amount_total ?? 0,
            buyerEmail: session.customer_details?.email ?? "unknown",
            status: "paid",
            paymentProvider: "STRIPE",
            externalOrderId: session.id,
            // Real gap closed (2026-08-09) — the charge-level id, distinct
            // from externalOrderId (the checkout-level id above). A refund
            // webhook (charge.refunded) arrives keyed by payment_intent, not
            // by Checkout Session — without this, a refund has no way to
            // find its own Order. Not expanded on this session (no `expand`
            // was requested), so it's always the plain id string here.
            externalPaymentId: typeof session.payment_intent === "string" ? session.payment_intent : null,
            // Real, verified against the installed Stripe SDK's own types
            // before writing this — this API version nests it under
            // collected_information, not directly on the session (an
            // older-version shape this codebase's training data would
            // have assumed instead — see AGENTS.md's warning about that).
            // Live shipping (2026-08-20). When the customer chose a shipping
            // service on the storefront, they typed their address there and
            // Stripe was never asked to collect it again — so it arrives in
            // metadata instead. Stripe's own collected_information remains the
            // source for every other checkout, unchanged.
            shippingAddress:
              (chosenShipping.address as object | null) ??
              fromStripeShippingDetails(session.collected_information?.shipping_details) ??
              undefined,
            // What the CUSTOMER paid to ship. Distinct from shippingCostInCents
            // (what the label later costs the owner) on purpose — see the
            // schema comment; the gap between them is the store's margin.
            shippingChargedInCents: chosenShipping.amountInCents ?? undefined,
            selectedShippingCarrier: chosenShipping.carrier ?? undefined,
            selectedShippingService: chosenShipping.service ?? undefined,
            selectedShippingRateId: chosenShipping.rateId ?? undefined,
            selectedShippingEstDays: chosenShipping.estimatedDays ?? undefined,
          },
        });

        const transaction = mapOrdersToTransactions([order])[0];
        await writeBusinessEvents(tx, storeId, "internal", [
          {
            recordId: internalTransactionId(order.id),
            entityType: "transaction",
            eventType: "transaction.created",
            summary: `Sale: ${order.productName} ($${(order.amountInCents / 100).toFixed(2)})`,
            data: transaction.data,
          },
        ]);
      });
      } catch (error) {
        // See lib/orders/orderFailure.ts for why the two are told apart.
        const permanent = isPermanentOrderFailure(error);

        reportIssue(
          permanent
            ? `a payment could not become an order and never will (${String((error as { code?: unknown }).code)})`
            : "a payment could not become an order",
          error,
          {
            subsystem: "payments",
            stage: permanent ? "stripe.order.permanent" : "stripe.order.transient",
            storeId,
            extra: { sessionId: session.id, amountTotal: session.amount_total ?? null },
          }
        );

        if (!permanent) {
          // Rethrow so Next answers 500 and Stripe retries — which is the
          // behaviour that actually recovers a transient database failure.
          throw error;
        }
        return new Response("OK", { status: 200 });
      }

      // Phase 4 — a completed order is exactly a "business state may have
      // just changed" moment (e.g. inventory heading toward a stockout).
      // Scheduled via after() so Stripe still gets its expected fast ack.
      // Phase 5's measurement sweep rides the same trigger — deterministic,
      // zero AI cost, a no-op unless a past approval's window has elapsed.
      after(() =>
        Promise.all([
          runDeterministicObservationSweep(storeId),
          measureDueMeasurements(storeId),
        ]).catch(() => {})
      );
    }
  }

  // Real gap closed (2026-08-09) — refunds previously had no code path at
  // all: an owner refunding a customer directly in their own Stripe
  // Dashboard left Genesis's own Order.status stuck on "paid" forever, even
  // though the UI already had a "Refunded" label ready and
  // internalMapper.ts already reads order.status === "refunded" for
  // reporting. This is the writer that label/read path was always missing.
  if (event.type === "charge.refunded") {
    const charge = event.data.object as Stripe.Charge;
    const paymentIntentId = typeof charge.payment_intent === "string" ? charge.payment_intent : null;
    // Only a genuinely full refund flips status — a partial refund doesn't
    // change what the owner still needs to fulfill/ship, and silently
    // relabeling a still-substantially-paid order "refunded" would mislead
    // the owner. Partial refunds are a real, named gap (not reflected in
    // Order.status at all yet), not a silent oversight.
    const isFullRefund = charge.amount_refunded >= charge.amount;
    if (paymentIntentId && isFullRefund) {
      // Fetch-then-scope, the same confirmed-safe pattern used elsewhere in
      // this codebase (lib/tenantIsolation.ts): a bare single-record lookup
      // (findFirst) is allowed unscoped, but the actual mutation must carry
      // a real storeId in its own where clause — the refund event itself
      // only gives us a payment_intent id, so the store has to be resolved
      // first before the update can satisfy that guard.
      const target = await prisma.order.findFirst({
        where: { paymentProvider: "STRIPE", externalPaymentId: paymentIntentId },
        select: { id: true, storeId: true, status: true },
      });
      if (target && target.status !== "refunded") {
        await prisma.order.update({
          where: { id: target.id, storeId: target.storeId },
          data: { status: "refunded" },
        });
      }
    }
  }

  return new Response("OK", { status: 200 });
}
