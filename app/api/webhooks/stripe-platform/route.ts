import Stripe from "stripe";
import { prisma } from "@/lib/prisma";
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
const webhookSecret = process.env.STRIPE_PLATFORM_WEBHOOK_SECRET!;

export async function POST(request: Request) {
  const body = await request.text();
  const signature = request.headers.get("stripe-signature");

  if (!signature) {
    return new Response("Missing signature", { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
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
      } else {
        await creditGrowthPointsFromPurchase({
          storeId,
          amount: pointAmount,
          externalRef: session.id,
          description: `Purchased ${pointAmount} Growth Point${pointAmount === 1 ? "" : "s"}`,
        });
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
      } else {
        // The Checkout Session itself doesn't carry the subscription's own
        // current status/period — retrieved directly rather than relying
        // on a separate customer.subscription.created event's delivery
        // order, so this is correct even if that event arrives later (or
        // is lost).
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
