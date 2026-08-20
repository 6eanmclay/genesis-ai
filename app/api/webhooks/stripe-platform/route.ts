import { checkWebhookSecret } from "@/lib/observability/webhookConfig";
import { reportIssue } from "@/lib/observability/reportIssue";
import { randomUUID } from "crypto";
import Stripe from "stripe";
import { prisma } from "@/lib/prisma";
import { recordExecution } from "@/lib/execution/log";
import { EXECUTION_ACTIONS } from "@/lib/execution/actions";
import { CURRENT_EXECUTION_SCHEMA_VERSION } from "@/lib/execution/types";
import { creditGrowthPointsFromPurchase } from "@/lib/growthPoints/ledger";

// Chapter 5 (Payments) — a genuinely separate webhook endpoint from
// app/api/webhooks/stripe/route.ts, not an extension of it. That route
// exists for the MERCHANT's own connected-account activity (their
// customers paying them) and its event.account-based Connect-vs-platform
// branching would be dead weight here: every event this route ever
// receives is a platform-key event (Genesis billing the store owner
// directly), so session.metadata is trusted directly, with no
// externalAccountId disambiguation needed. Stripe supports multiple
// webhook endpoints with independent secrets on one account — this is
// normal, not a workaround.
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);


/**
 * A durable, owner-visible record that a platform payment could not be applied.
 *
 * Only possible when the store resolved. When it did not there is genuinely no
 * store to attach anything to, and the console line above is the honest limit —
 * stated rather than quietly accepted, the same as the storefront webhook.
 */
async function recordUnappliedPayment(
  storeId: string | undefined,
  sessionId: string,
  what: string
): Promise<void> {
  if (!storeId) return;
  try {
    await recordExecution({
      executionId: randomUUID(),
      action: EXECUTION_ACTIONS.BILLING_STRIPE_UNAPPLIED,
      status: "FAILED",
      verified: false,
      message: `A payment completed in Stripe (session ${sessionId}) but ${what}. Reconcile this before assuming it was not a real payment.`,
      retryable: false,
      actorType: "USER",
      actorId: null,
      storeId,
      storeDraftId: null,
      schemaVersion: CURRENT_EXECUTION_SCHEMA_VERSION,
      timestamp: new Date(),
      metadata: { sessionId },
    });
  } catch (error) {
    reportIssue("could not record an unapplied payment", error, {
      subsystem: "billing",
      stage: "stripe.unapplied.persist",
      storeId,
      extra: { sessionId },
    });
  }
}

export async function POST(request: Request) {
  const body = await request.text();
  const signature = request.headers.get("stripe-signature");

  // Read per request, not at module load: a config check that runs once when
  // the lambda cold-starts cannot report anything useful, and the value can
  // change between deploys.
  const configured = checkWebhookSecret(process.env.STRIPE_PLATFORM_WEBHOOK_SECRET, "STRIPE_PLATFORM_WEBHOOK_SECRET");
  if (!configured.ok) {
    // 500, NOT 400. 400 tells Stripe the request is permanently bad and it
    // stops retrying, which turns a missing environment variable into real
    // payments that never became orders. See lib/observability/webhookConfig.ts.
    reportIssue(configured.reason, new Error("STRIPE_PLATFORM_WEBHOOK_SECRET is not set"), {
      subsystem: "billing",
      stage: "stripe.platform.webhook.config",
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

    if (session.mode === "payment") {
      const storeId = session.metadata?.storeId;
      const pointAmountRaw = session.metadata?.pointAmount;
      const pointAmount = pointAmountRaw ? Number(pointAmountRaw) : NaN;

      if (!storeId || !Number.isFinite(pointAmount) || pointAmount <= 0) {
        console.error("[stripe-platform webhook] could not resolve a Growth Point purchase", {
          sessionId: session.id,
          storeId: storeId ?? null,
          pointAmountRaw: pointAmountRaw ?? null,
        });
        // Someone paid Genesis for points and received none. Until 2026-08-20
        // the console line was the only trace of that.
        await recordUnappliedPayment(storeId, session.id, "a Growth Point purchase could not be applied");
      } else {
        // A storeId that no longer resolves — the store was deleted between
        // checkout and delivery, or the metadata is stale — used to throw
        // P2025 straight out of this handler. That returned a 500, so Stripe
        // retried for days against something that could never succeed, and the
        // payment left no trace anyone would find.
        //
        // Found by verify-webhook-handlers.ts, which sends exactly that event.
        try {
          await creditGrowthPointsFromPurchase({
            storeId,
            amount: pointAmount,
            externalRef: session.id,
            description: `Purchased ${pointAmount} Growth Point${pointAmount === 1 ? "" : "s"}`,
          });
        } catch (error) {
          reportIssue(`could not credit Growth Points for ${session.id}`, error, {
            subsystem: "billing",
            stage: "stripe.points.credit",
            storeId,
            extra: { sessionId: session.id, pointAmount },
          });
          await recordUnappliedPayment(storeId, session.id, "the Growth Point purchase could not be credited");
        }
      }
    }

    if (session.mode === "subscription") {
      const storeId = session.metadata?.storeId;
      const planId = session.metadata?.planId;
      const subscriptionId =
        typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
      const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;

      if (!storeId || !planId || !subscriptionId) {
        console.error("[stripe-platform webhook] could not resolve a Plan subscription", {
          sessionId: session.id,
          storeId: storeId ?? null,
          planId: planId ?? null,
        });
        // A subscription was paid for and no store is on the plan.
        await recordUnappliedPayment(storeId, session.id, "a plan subscription could not be applied");
      } else {
        // The Checkout Session itself doesn't carry the subscription's own
        // current status/period — retrieved directly rather than relying
        // on a separate customer.subscription.created event's delivery
        // order, so this is correct even if that event arrives later (or
        // is lost).
        // Same shape as the purchase branch above: a store that no longer
        // exists must not turn into an unbounded Stripe retry loop.
        try {
          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          await prisma.store.update({
            where: { id: storeId },
            data: {
            planId,
            ...(customerId ? { stripeCustomerId: customerId } : {}),
            stripeSubscriptionId: subscription.id,
            subscriptionStatus: subscription.status,
            subscriptionCurrentPeriodEnd: new Date(subscription.items.data[0].current_period_end * 1000),
            // Deliberately left untouched (stays null on a first
            // subscription) — the existing, unmodified monthly-refresh
            // sweep (lib/growthPoints/refresh.ts) picks up any store with
            // a non-null planId and a null/due growthPointNextRefreshAt on
            // its own very next run and grants the real first-month
            // allowance itself. This is the whole proof that Chapter 5
            // integrates into Chapter 2 rather than reimplementing it.
            },
          });
        } catch (error) {
          reportIssue(`could not apply subscription for ${session.id}`, error, {
            subsystem: "billing",
            stage: "stripe.subscription.apply",
            storeId,
            extra: { sessionId: session.id, planId },
          });
          await recordUnappliedPayment(storeId, session.id, "the plan subscription could not be applied");
        }
      }
    }
  }

  if (event.type === "customer.subscription.updated") {
    const subscription = event.data.object as Stripe.Subscription;
    // Idempotent by construction — just overwrites to Stripe's own current
    // truth every time, so a redelivered event is a harmless no-op.
    await prisma.store.updateMany({
      where: { stripeSubscriptionId: subscription.id },
      data: {
        subscriptionStatus: subscription.status,
        subscriptionCurrentPeriodEnd: new Date(subscription.items.data[0].current_period_end * 1000),
      },
    });
  }

  if (event.type === "customer.subscription.deleted") {
    const subscription = event.data.object as Stripe.Subscription;
    // Deliberately does NOT null planId — keeps historical/display
    // coherence (which plan this store was on), same "keep historical
    // truth, gate future behavior separately" idiom as ExecutionLog's own
    // append-only design. What actually stops further monthly grants is
    // gating the refresh sweep's own due-query on subscriptionStatus.
    await prisma.store.updateMany({
      where: { stripeSubscriptionId: subscription.id },
      data: { subscriptionStatus: "canceled" },
    });
  }

  return new Response("OK", { status: 200 });
}
